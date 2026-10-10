// `bounded catalog build` (ADR 2026-026): run, as a pack author runs it, by the
// built CLI under Node in a copy of the demonstration package
// (src/core/test/fixtures/catalog/demo-package/), its pack built to
// JavaScript with Bun.build, bounded installed as a link to src/ and the
// libraries the build resolves from the package linked to the repository's.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PackageCatalog } from "bounded/domain";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const BOUNDED_DIR = join(REPOSITORY_ROOT, "src");
const CLI = join(BOUNDED_DIR, "dist", "cli.js");
const DEMO_PACKAGE = join(BOUNDED_DIR, "core", "test", "fixtures", "catalog", "demo-package");
const LIBRARIES = ["typescript", "ts-json-schema-generator", "marked"];
const EXAMPLE = "packs/demo/examples/basic.config.ts";

interface DemoOptions {
  readonly files?: Readonly<Record<string, string>>;
  readonly remove?: readonly string[];
  readonly manifest?: (manifest: Record<string, unknown>) => Record<string, unknown>;
  readonly libraries?: readonly string[];
}

/** A fresh copy of the demonstration package, its pack built to dist/demo/index.js. */
async function demoPackage(options: DemoOptions = {}): Promise<string> {
  const packageDir = realpathSync(mkdtempSync(join(tmpdir(), "bounded-catalog-cli-")));
  cpSync(DEMO_PACKAGE, packageDir, { recursive: true });
  for (const path of options.remove ?? []) rmSync(join(packageDir, path), { recursive: true, force: true });
  for (const [path, text] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(packageDir, path)), { recursive: true });
    writeFileSync(join(packageDir, path), text);
  }
  if (options.manifest !== undefined) {
    const manifestPath = join(packageDir, "package.json");
    writeFileSync(manifestPath, `${JSON.stringify(options.manifest(JSON.parse(readFileSync(manifestPath, "utf8"))), null, 2)}\n`);
  }
  mkdirSync(join(packageDir, "node_modules"));
  symlinkSync(BOUNDED_DIR, join(packageDir, "node_modules", "bounded"), "dir");
  for (const library of options.libraries ?? LIBRARIES) symlinkSync(join(REPOSITORY_ROOT, "node_modules", library), join(packageDir, "node_modules", library), "dir");
  const built = await Bun.build({ entrypoints: [join(packageDir, "packs", "demo", "index.ts")], outdir: join(packageDir, "dist", "demo"), target: "node", format: "esm", packages: "external" });
  if (!built.success) throw new AggregateError(built.logs, "the demonstration pack could not be built");
  return packageDir;
}

/** `bounded <args>`, the built CLI, under Node in `cwd`. */
function bounded(args: readonly string[], cwd: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const ran = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

const catalogueIn = (packageDir: string): Record<string, unknown> => JSON.parse(readFileSync(join(packageDir, "bounded.catalog.json"), "utf8"));
interface DemoEntry {
  readonly id: string;
  readonly importPath: string;
  readonly exportName: string;
  readonly summary: string;
  readonly documentation: string;
  readonly dependsOn: readonly string[];
  readonly contributesTo: readonly string[];
  readonly points: readonly { id: string; key: string; description: string; documentation: string; valueType: string; wire: { type: string; schema: Record<string, unknown> } | null }[];
  readonly ports: readonly { id: string; key: string; adapterType: string; documentation: string; declaration: string }[];
  readonly readme: Record<string, unknown>;
  readonly examples: readonly { path: string; title: string; description: string; source: string }[];
}
const demoEntryIn = (packageDir: string): DemoEntry => (catalogueIn(packageDir).packs as DemoEntry[])[0] as DemoEntry;

/** A refused build: exit 1, `bounded: <refusal>` on stderr, and no catalogue written. */
function expectRefused(packageDir: string, ran: ReturnType<typeof bounded>, ...named: string[]): void {
  expect({ status: ran.status, stdout: ran.stdout }).toEqual({ status: 1, stdout: "" });
  expect(ran.stderr).toStartWith("bounded: ");
  for (const name of named) expect(ran.stderr).toContain(name);
  expect(existsSync(join(packageDir, "bounded.catalog.json"))).toBe(false);
}

describe("bounded catalog build", () => {
  test("writes the package's catalogue from the pack object", async () => {
    const packageDir = await demoPackage();
    const ran = bounded(["catalog", "build"], packageDir);
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("Wrote bounded.catalog.json");
    expect(ran.stdout).toContain("demo-package/demo");
    const catalogue = catalogueIn(packageDir);
    expect(catalogue.catalogVersion).toBe(1);
    expect(catalogue.package).toEqual({ name: "demo-package", version: "1.0.0" });
    const entry = demoEntryIn(packageDir);
    expect({ id: entry.id, importPath: entry.importPath, exportName: entry.exportName }).toEqual({ id: "demo-package/demo", importPath: "demo-package/demo", exportName: "demoPack" });
    expect(entry.dependsOn).toEqual(["bounded/core"]);
    expect(entry.contributesTo).toEqual(["bounded/core.beforeTool"]);
    expect(entry.points.map(({ id, key, description }) => ({ id, key, description }))).toEqual([{ id: "demo-package/demo.notes", key: "notes", description: "Notes a project keeps for its agents" }]);
    expect(entry.ports.map(({ id, key }) => ({ id, key }))).toEqual([{ id: "demo-package/demo#noteStore", key: "noteStore" }]);
  });

  test("takes the typed API from the contract and TSDoc, with no @implementedBy in it", async () => {
    const packageDir = await demoPackage();
    expect(bounded(["catalog", "build"], packageDir).status).toBe(0);
    const entry = demoEntryIn(packageDir);
    expect(entry.documentation).toStartWith("The demonstration pack, `demo-package/demo`");
    expect(entry.points[0]).toMatchObject({ valueType: "Note", documentation: "Notes: one line of text each, kept by the project for its agents.", wire: { type: "NoteJSON" } });
    expect(entry.points[0]?.wire?.schema).toMatchObject({ definitions: { NoteJSON: { properties: { text: { type: "string" } } } } });
    expect(entry.ports[0]).toMatchObject({ adapterType: "NoteStore", documentation: "Where notes are kept between tool calls." });
    expect(entry.ports[0]?.declaration).toStartWith("interface NoteStore {");
    expect(readFileSync(join(packageDir, "bounded.catalog.json"), "utf8")).not.toContain("@implementedBy");
  });

  test("joins the README and embeds the example verbatim", async () => {
    const packageDir = await demoPackage();
    expect(bounded(["catalog", "build"], packageDir).status).toBe(0);
    const entry = demoEntryIn(packageDir);
    expect(entry.summary).toBe("a demonstration pack");
    expect(entry.readme).toMatchObject({
      path: "packs/demo/README.md",
      introduction: "A pack for the package catalogue build's tests.",
      whatItIsFor: "Keeping notes a project writes for its agents.",
      ruleShape: "Projects contribute notes to `notes`: `{ text }`, one line each.",
      ports: "- `noteStore` (`NoteStore`): where notes are kept.",
      otherSections: [{ heading: "Records", markdown: "None are kept." }],
    });
    expect(entry.examples).toEqual([{ path: EXAMPLE, title: "Keep a note", description: "The project keeps one note for its agents: where plans live.", source: readFileSync(join(packageDir, EXAMPLE), "utf8") }]);
  });

  test("parses as a PackageCatalog, holds no absolute path, and is the same bytes twice", async () => {
    const packageDir = await demoPackage();
    expect(bounded(["catalog", "build"], packageDir).status).toBe(0);
    const first = readFileSync(join(packageDir, "bounded.catalog.json"), "utf8");
    const parsed = PackageCatalog.parse(JSON.parse(first));
    expect(parsed.ok ? "parsed" : parsed.error).toBe("parsed");
    expect(first).not.toContain(packageDir);
    expect(first).not.toContain(REPOSITORY_ROOT);
    expect(first).not.toContain(tmpdir());
    expect(bounded(["catalog", "build"], packageDir).status).toBe(0);
    expect(readFileSync(join(packageDir, "bounded.catalog.json"), "utf8")).toBe(first);
  });

  test("refuses a README missing `## Workflows it fits`, naming the pack, the README and the heading, and writes nothing", async () => {
    const readme = readFileSync(join(DEMO_PACKAGE, "packs", "demo", "README.md"), "utf8").replace(/## Workflows it fits\n\n[^\n]*\n\n/, "");
    expect(readme).not.toContain("Workflows it fits");
    const packageDir = await demoPackage({ files: { "packs/demo/README.md": readme } });
    expectRefused(packageDir, bounded(["catalog", "build"], packageDir), "demo-package/demo", "packs/demo/README.md", "## Workflows it fits");
  });

  test("refuses a pack with no README", async () => {
    const packageDir = await demoPackage({ remove: ["packs/demo/README.md"] });
    expectRefused(packageDir, bounded(["catalog", "build"], packageDir), "demo-package/demo", "packs/demo/README.md");
  });

  test("refuses a pack with no example", async () => {
    const packageDir = await demoPackage({ remove: ["packs/demo/examples"] });
    expectRefused(packageDir, bounded(["catalog", "build"], packageDir), "demo-package/demo", "examples/");
  });

  test("refuses a package.json with no bounded.packs", async () => {
    const packageDir = await demoPackage({ manifest: ({ bounded: _bounded, ...rest }) => rest });
    expectRefused(packageDir, bounded(["catalog", "build"], packageDir), "bounded.packs", "package.json");
  });

  test("refuses an export path that exports no pack, and one that exports two", async () => {
    const none = await demoPackage({ files: { "packs/demo/index.ts": 'export { Note } from "./domain/note.ts";\n' } });
    expectRefused(none, bounded(["catalog", "build"], none), "./demo", "no pack");
    const twoPacks = 'import { definePack, packIdsFor } from "bounded/domain";\nexport { demoPack } from "./demo.pack.ts";\nexport const otherPack = definePack({ id: packIdsFor("demo-package")("other") });\n';
    const two = await demoPackage({ files: { "packs/demo/index.ts": twoPacks } });
    expectRefused(two, bounded(["catalog", "build"], two), "./demo", "demoPack", "otherPack");
  });

  test("refuses an id not rooted at the package's name", async () => {
    const otherId = readFileSync(join(DEMO_PACKAGE, "packs", "demo", "domain", "demo-id.ts"), "utf8").replaceAll("demo-package", "other-package");
    const packageDir = await demoPackage({ files: { "packs/demo/domain/demo-id.ts": otherId } });
    expectRefused(packageDir, bounded(["catalog", "build"], packageDir), "other-package/demo", "demo-package");
  });

  test("refuses a contract and pack object that disagree on a key", async () => {
    const contract = readFileSync(join(DEMO_PACKAGE, "packs", "demo", "demo.contract.ts"), "utf8").replace("readonly notes:", "readonly jottings:");
    const packageDir = await demoPackage({ files: { "packs/demo/demo.contract.ts": contract } });
    expectRefused(packageDir, bounded(["catalog", "build"], packageDir), "demo-package/demo", "jottings", "notes");
  });

  test("refuses, naming it, when marked cannot be resolved from the package", async () => {
    const packageDir = await demoPackage({ libraries: ["typescript", "ts-json-schema-generator"] });
    expectRefused(packageDir, bounded(["catalog", "build"], packageDir), "install marked as a devDependency");
  });

  test("refuses an export entry with only an import condition, naming the path and the fix", async () => {
    const packageDir = await demoPackage({ manifest: (manifest) => ({ ...manifest, exports: { "./demo": { import: "./dist/demo/index.js" } } }) });
    expectRefused(packageDir, bounded(["catalog", "build"], packageDir), "./demo", "add a `default` condition");
  });

  test("`bounded catalog` alone, or with an unknown option, prints usage and exits 2", async () => {
    const packageDir = await demoPackage();
    for (const args of [["catalog"], ["catalog", "build", "--watch"], ["catalog", "show"]]) {
      const ran = bounded(args, packageDir);
      expect({ args, status: ran.status, stdout: ran.stdout }).toEqual({ args, status: 2, stdout: "" });
      expect(ran.stderr).toContain("bounded catalog build");
    }
    expect(existsSync(join(packageDir, "bounded.catalog.json"))).toBe(false);
  });
});
