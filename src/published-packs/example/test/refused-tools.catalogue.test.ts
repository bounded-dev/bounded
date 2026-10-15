// bounded-example's catalogue (ADR 2026-029) and its README, checked as
// src/core/composition-root/pack-readmes.test.ts and pack-wire-schemas.test.ts
// check the shipped packs', which cover bounded's packs only (ADR 2026-030):
// the README is read by the catalogue build's own Markdown reader and rules,
// and the schema the catalogue gives the refusedTools point agrees with the
// point's run-time check.
//
// This test writes this package's gitignored bounded.catalog.json by running
// the built CLI's `bounded catalog build` in the package's directory, as its
// prepack does; src/test/published-pack-packaging.test.ts packs the package,
// which builds it too. They rely on `bun test` running test files one after
// another, and each test that reads the file rebuilds it first.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ajv } from "ajv";
import { FileSystemProjectConfigSource, MarkedMarkdownSections } from "bounded/adapters";
import { PackDescription, PackReadme } from "bounded/domain";
import { refusedToolsPack } from "../packs/refused-tools/index.ts";
import { refusedToolWireForms } from "../packs/refused-tools/domain/refused-tool.wire-forms.test-support.ts";

/** This package's directory, src/published-packs/example. */
const PACKAGE = resolve(import.meta.dir, "..");
/** bounded's directory, src/: its built CLI builds the catalogue, and a project's node_modules/bounded links to it. */
const BOUNDED = resolve(PACKAGE, "../..");
const README = "packs/refused-tools/README.md";
const REQUIRED_HEADINGS = ["What it is for", "Rule shape", "Workflows it fits", "What it observes", "What it cannot see", "Ports", "Examples"];
const ajv = new Ajv({ strict: false, allErrors: true });

interface CataloguedPack {
  readonly id: string;
  readonly points: readonly { readonly key: string; readonly wire: { readonly schema: Record<string, unknown> } | null }[];
}

/** This package's catalogue, rebuilt now by bounded's built CLI under Node; the packs it lists, or none when the build failed. */
function builtCatalogue(): { readonly packs: readonly CataloguedPack[]; readonly output: string } {
  const ran = spawnSync("node", [join(BOUNDED, "dist", "cli.js"), "catalog", "build"], { cwd: PACKAGE, encoding: "utf8" });
  const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  if (ran.status !== 0) return { packs: [], output };
  const catalogue = JSON.parse(readFileSync(join(PACKAGE, "bounded.catalog.json"), "utf8")) as { packs?: CataloguedPack[] };
  return { packs: catalogue.packs ?? [], output };
}

/** Whether `value` validates against the catalogue's schema for refusedTools, with ajv's errors when it does not; it throws when there is no schema. */
function validatesAgainst(catalogue: { readonly packs: readonly CataloguedPack[]; readonly output: string }, value: unknown): { readonly valid: boolean; readonly errors: string } {
  const schema = catalogue.packs.find((pack) => pack.id === "bounded-example/refused-tools")?.points.find((point) => point.key === "refusedTools")?.wire?.schema;
  if (schema === undefined) throw new Error(`the catalogue gives bounded-example/refused-tools.refusedTools no schema: ${catalogue.output}`);
  const validate = ajv.compile(schema);
  const valid = validate(value);
  return { valid, errors: ajv.errorsText(validate.errors) };
}

/** A project whose bounded.config.ts is `config`, with bounded and bounded-example installed as links. */
function projectWithConfig(config: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-example-catalogue-")));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(BOUNDED, join(root, "node_modules", "bounded"), "dir");
  symlinkSync(PACKAGE, join(root, "node_modules", "bounded-example"), "dir");
  writeFileSync(join(root, "bounded.config.ts"), config);
  return root;
}

describe("bounded-example's catalogue and README", () => {
  test("its README parses with the catalogue build's own rules: titled with the pack's id, the seven sections once each, refusedTools named in Rule shape, no configuration", async () => {
    const read = await new MarkedMarkdownSections().read(PACKAGE, readFileSync(join(PACKAGE, README), "utf8"));
    expect(read.ok ? null : read.error).toBeNull();
    if (!read.ok) return;
    const document = read.value;
    const description = PackDescription.of(refusedToolsPack);
    const parsed = PackReadme.parse({
      packId: description.id,
      path: README,
      title: document.title,
      introduction: document.introduction,
      sections: document.sections,
      pointKeys: description.points.map(({ key }) => key),
      portKeys: description.ports.map(({ key }) => key),
    });
    expect(parsed.ok ? null : parsed.error).toBeNull();
    expect(readFileSync(join(PACKAGE, README), "utf8")).toStartWith("# bounded-example/refused-tools: ");
    const headings = document.sections.map(({ heading }) => heading);
    for (const heading of REQUIRED_HEADINGS) expect({ heading, count: headings.filter((given) => given === heading).length }).toEqual({ heading, count: 1 });
    expect(document.sections.find((section) => section.heading === "Rule shape")?.codeSpans ?? []).toContain("refusedTools");
    const blocks = [...document.introduction.codeBlocks, ...document.sections.flatMap((section) => section.codeBlocks)];
    expect(blocks.filter((block) => block.includes("defineConfig("))).toEqual([]);
  });

  test("every wire form its tests accept validates against the catalogue's schema for refusedTools, every value its examples contribute validates, and what does not compile is rejected", async () => {
    const catalogue = builtCatalogue();
    expect(catalogue.output).toContain("Wrote bounded.catalog.json");
    expect(refusedToolWireForms.length).toBeGreaterThan(0);
    for (const form of refusedToolWireForms) expect({ form, ...validatesAgainst(catalogue, form) }).toEqual({ form, valid: true, errors: "No errors" });
    const examplePaths = [...new Glob("packs/*/examples/*.config.ts").scanSync({ cwd: PACKAGE })].sort();
    expect(examplePaths.length).toBeGreaterThan(0);
    for (const examplePath of examplePaths) {
      // The example is read as text and opened as a project's configuration: nothing imports it.
      const root = projectWithConfig(readFileSync(join(PACKAGE, examplePath), "utf8"));
      const loaded = await new FileSystemProjectConfigSource().load(root);
      expect({ example: examplePath, loaded: loaded.ok ? "ok" : loaded.error }).toEqual({ example: examplePath, loaded: "ok" });
      if (!loaded.ok) continue;
      const composed = loaded.value.compose();
      expect({ example: examplePath, composed: composed.ok ? "ok" : composed.error }).toEqual({ example: examplePath, composed: "ok" });
      if (!composed.ok) continue;
      const rules = composed.value.read(refusedToolsPack.points.refusedTools);
      const contributed = rules.ok ? rules.value.map((rule) => rule.toJSON()) : [];
      expect({ example: examplePath, contributes: contributed.length > 0 }).toEqual({ example: examplePath, contributes: true });
      for (const wire of contributed) expect({ example: examplePath, wire, ...validatesAgainst(catalogue, wire) }).toEqual({ example: examplePath, wire, valid: true, errors: "No errors" });
    }
    for (const rejected of [{ tool: "x" }, { tool: "x", redirect: "y", extra: 1 }, { redirect: "y" }, { tool: "WebFetch", redirect: "y" }]) {
      expect({ rejected, valid: validatesAgainst(catalogue, rejected).valid }).toEqual({ rejected, valid: false });
    }
  });
});
