// dogfood structure-compare — how far a dogfood run's tree is from a worked
// example's, file role by file role.
//
//   node scripts/dogfood/structure-compare.ts [--example <dir>] [--json] <project>
//
// The worked example is a local checkout that is never committed here: pass
// it with --example or set BOUNDED_EXAMPLE_PROJECT. The report says, for the
// project against the example:
//
//   · shapes    how many files of each role each tree has, with the business
//               names taken out (`<area>/<feature>/<feature>.handler.ts` ×5),
//               so two different products can still be compared;
//   · files     the files one tree has and the other lacks, with only the
//               context's name taken out, which is what a run of the same
//               product should reproduce exactly;
//   · contracts the exported names of every contract both trees have, where
//               they differ;
//   · tests     which test levels each tree has. Test files are compared by
//               level only: which tests a run writes is its own business, that
//               every level exists is the structure's.
//
// Harness artifacts (.bounded/, agent instructions, ticket notes, shipped
// check scripts), dependencies, build output and lockfiles are ignored.
// Deterministic: the same two trees always give the same report. Exit 0 when
// there is no delta, 1 when there is one, 2 on misuse.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// --- what is ignored --------------------------------------------------------------

/** Directory names skipped wherever they appear. */
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".cache", ".turbo"]);

/** Root-relative paths (a file, or a directory with a trailing slash) that are
 *  the harness's or the agent host's, not the product's. */
const HARNESS_ARTIFACTS = [
  ".bounded/", ".claude/", ".pi/", ".run/", "scratch/", "docs/tn/", "scripts/", "ADRs/",
  "AGENTS.md", "CLAUDE.md", "CONTEXT.md", "apps/README.md",
];

/** File names that are never structure: lockfiles, local settings, OS noise. */
const SKIPPED_FILES = /^(?:bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.DS_Store|.*\.tsbuildinfo|.*\.log|\.env(?:\.(?!example$)[^/]*)?)$/;

const TEST_SIDE = /\.(?:test\.tsx?|test-support\.ts)(?:\.snap)?$/;

// --- walking and naming -----------------------------------------------------------

function isHarnessArtifact(path: string): boolean {
  return HARNESS_ARTIFACTS.some((artifact) => (artifact.endsWith("/") ? path.startsWith(artifact) : path === artifact));
}

/** Every product file under `root`, root-relative with `/`, sorted. */
export function productFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !isHarnessArtifact(`${path}/`)) walk(path);
      } else if (entry.isFile() && !SKIPPED_FILES.test(entry.name) && !isHarnessArtifact(path)) {
        out.push(path);
      }
    }
  };
  walk("");
  return out.sort();
}

/** The one context's directory name, when the tree has exactly one. With
 *  several, names stay literal: which context a file is in is then structure. */
function soleContext(files: readonly string[]): string | undefined {
  const contexts = new Set(files.filter((f) => f.startsWith("contexts/")).map((f) => f.split("/")[1]!));
  return contexts.size === 1 ? [...contexts][0] : undefined;
}

/** A migration's generated name carries a random word: `0000_mute_wong.sql`. */
function migrationName(segment: string): string {
  return segment.replace(/^\d{4}_[a-z0-9_]+\.sql$/, "<migration>.sql").replace(/^\d{4}_snapshot\.json$/, "<migration>_snapshot.json");
}

/** The path with the sole context's name replaced by `<context>`. */
export function namedPath(path: string, context: string | undefined): string {
  const segments = path.split("/").map((segment, i, all) => {
    let s = all[i - 1] === "migrations" || all[i - 2] === "migrations" ? migrationName(segment) : segment;
    if (context !== undefined) {
      if (s === context) s = "<context>";
      else if (s.startsWith(`${context}.`)) s = `<context>${s.slice(context.length)}`;
      else if (s.startsWith(`${context}-`)) s = `<context>${s.slice(context.length)}`;
    }
    return s;
  });
  return segments.join("/");
}

/** The file's role suffix: everything from the first dot of its name. */
function roleSuffix(name: string): { stem: string; suffix: string } {
  const dot = name.indexOf(".");
  return dot <= 0 ? { stem: name, suffix: "" } : { stem: name.slice(0, dot), suffix: name.slice(dot) };
}

/**
 * The file's shape: its named path with the business names taken out. Under a
 * context's `src/`, the folders below a layer are an area and a feature
 * (application), an area (domain), or a technology and an area (adapters);
 * a file stem that repeats one of them is replaced by it, and any other stem
 * in an area or feature folder is a `<concept>`.
 */
export function shapeOf(named: string): string {
  const parts = named.split("/");
  const src = parts[0] === "contexts" ? parts.indexOf("src") : -1;
  if (src < 0) return named;
  const layer = parts[src + 1];
  const tail = parts.slice(src + 2);
  const file = tail.pop();
  if (file === undefined || layer === undefined) return named;
  const labels: string[] = [];
  const dirs = tail.map((dir, i) => {
    let label = dir;
    if (layer === "domain" && i === 0 && dir !== "shared") label = "<area>";
    if (layer === "application" && dir !== "shared") label = i === 0 ? "<area>" : i === 1 ? "<feature>" : dir;
    if (layer === "adapters" && i >= 2 && !["schema", "migrations", "meta"].includes(dir)) label = i === 2 ? "<area>" : dir;
    labels.push(label);
    return label;
  });
  const { stem, suffix } = roleSuffix(file);
  const at = tail.lastIndexOf(stem);
  const inBusinessFolder = labels.some((label) => label === "<area>" || label === "<feature>");
  // In an adapter's area folder a file is named for its feature
  // (`create-note.store.ts`), except a mapper, named for its concept.
  const businessStem = layer === "adapters" && suffix !== ".mapper.ts" ? "<feature>" : "<concept>";
  const shapedStem = at >= 0 && labels[at] !== tail[at] ? labels[at]!
    : inBusinessFolder && stem !== "index" ? businessStem
      : layer === "adapters" && tail.at(-1) === "schema" && suffix === ".ts" ? "<area>"
        : stem;
  return [...parts.slice(0, src + 2), ...dirs, `${shapedStem}${suffix}`].join("/");
}

/** The names a contract file exports, sorted. */
export function exportedNames(source: string): string[] {
  const names = new Set<string>();
  const declared = /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|const|let|class|function|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(declared)) names.add(match[1]!);
  for (const match of source.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

// --- test levels ------------------------------------------------------------------

/** The test level a test-side file belongs to (ADR 2026-063's levels). */
export function testLevel(path: string): string {
  const parts = path.split("/");
  const name = parts.at(-1)!;
  if (path === "architecture.test.ts") return "architecture";
  if (parts[0] === "apps") return name.startsWith("composition-root.test.") ? `app smoke (${parts[1]})` : `app other (${parts[1]})`;
  const src = parts.indexOf("src");
  const layer = parts[src + 1];
  if (name.endsWith(".laws.test.ts")) {
    if (layer === "domain") return "domain laws";
    if (name.endsWith(".command.laws.test.ts")) return "command laws";
    if (layer === "adapters" && parts[src + 2] === "in") return `in-adapter laws (${parts[src + 3]})`;
    return "other laws";
  }
  if (layer === "domain") return "domain unit";
  if (layer === "application") {
    if (name.endsWith(".store.test-support.ts")) return "store conformance suite";
    if (name.endsWith(".test.ts") && parts.length - src === 5) return "handler";
    return "application other";
  }
  if (layer === "adapters" && parts[src + 2] === "out") {
    const tech = parts[src + 3];
    if (name.endsWith(".test-support.ts")) return `store test support (${tech})`;
    if (name.endsWith(".store.test.ts")) return `store (${tech})`;
    return `out adapter (${tech})`;
  }
  return "other";
}

// --- the signature and the comparison ----------------------------------------------

export interface TreeSignature {
  /** Named path → exported names (contracts) or null (every other file). */
  readonly files: ReadonlyMap<string, readonly string[] | null>;
  /** Shape → how many files have it. */
  readonly shapes: ReadonlyMap<string, number>;
  /** Test level → how many test files are at it. */
  readonly testLevels: ReadonlyMap<string, number>;
}

export function signatureOf(root: string): TreeSignature {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
  const all = productFiles(root);
  const context = soleContext(all);
  const files = new Map<string, readonly string[] | null>();
  const shapes = new Map<string, number>();
  const testLevels = new Map<string, number>();
  for (const path of all) {
    const named = namedPath(path, context);
    if (TEST_SIDE.test(path) || path === "architecture.test.ts") {
      const level = testLevel(named);
      testLevels.set(level, (testLevels.get(level) ?? 0) + 1);
      continue;
    }
    files.set(named, path.endsWith(".contract.ts") ? exportedNames(readFileSync(join(root, path), "utf8")) : null);
    const shape = shapeOf(named);
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  return { files, shapes, testLevels };
}

export interface StructureReport {
  readonly shapes: readonly { shape: string; expected: number; actual: number }[];
  readonly missingFiles: readonly string[];
  readonly extraFiles: readonly string[];
  readonly contracts: readonly { path: string; missing: readonly string[]; extra: readonly string[] }[];
  readonly missingTestLevels: readonly string[];
  readonly extraTestLevels: readonly string[];
  readonly testLevels: readonly { level: string; expected: number; actual: number }[];
  readonly deltas: number;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareSignatures(expected: TreeSignature, actual: TreeSignature): StructureReport {
  const shapeKeys = [...new Set([...expected.shapes.keys(), ...actual.shapes.keys()])].sort(byCodePoint);
  const shapes = shapeKeys
    .map((shape) => ({ shape, expected: expected.shapes.get(shape) ?? 0, actual: actual.shapes.get(shape) ?? 0 }))
    .filter((row) => row.expected !== row.actual);
  const missingFiles = [...expected.files.keys()].filter((path) => !actual.files.has(path)).sort(byCodePoint);
  const extraFiles = [...actual.files.keys()].filter((path) => !expected.files.has(path)).sort(byCodePoint);
  const contracts = [...expected.files.entries()]
    .filter(([path, names]) => names !== null && actual.files.get(path) != null)
    .map(([path, names]) => {
      const theirs = actual.files.get(path)!;
      return {
        path,
        missing: names!.filter((name) => !theirs.includes(name)),
        extra: theirs.filter((name) => !names!.includes(name)),
      };
    })
    .filter((row) => row.missing.length > 0 || row.extra.length > 0)
    .sort((a, b) => byCodePoint(a.path, b.path));
  const levelKeys = [...new Set([...expected.testLevels.keys(), ...actual.testLevels.keys()])].sort(byCodePoint);
  const testLevels = levelKeys.map((level) => ({
    level, expected: expected.testLevels.get(level) ?? 0, actual: actual.testLevels.get(level) ?? 0,
  }));
  const missingTestLevels = testLevels.filter((row) => row.expected > 0 && row.actual === 0).map((row) => row.level);
  const extraTestLevels = testLevels.filter((row) => row.expected === 0 && row.actual > 0).map((row) => row.level);
  const deltas = shapes.length + missingFiles.length + extraFiles.length + contracts.length +
    missingTestLevels.length + extraTestLevels.length;
  return { shapes, missingFiles, extraFiles, contracts, missingTestLevels, extraTestLevels, testLevels, deltas };
}

export function compareTrees(exampleRoot: string, projectRoot: string): StructureReport {
  return compareSignatures(signatureOf(exampleRoot), signatureOf(projectRoot));
}

export function formatReport(report: StructureReport): string {
  const lines: string[] = [];
  lines.push(report.deltas === 0
    ? "structure: no structural delta against the example"
    : `structure: ${report.deltas} structural delta(s) against the example`);
  const section = (title: string, rows: readonly string[]): void => {
    if (rows.length === 0) return;
    lines.push("", `${title}:`, ...rows.map((row) => `  ${row}`));
  };
  section("file shapes whose count differs (example → project)",
    report.shapes.map((row) => `${row.shape}  ${row.expected} → ${row.actual}`));
  section("files the example has and the project lacks", report.missingFiles);
  section("files the project has and the example lacks", report.extraFiles);
  section("contracts whose exported names differ", report.contracts.map((row) =>
    `${row.path}${row.missing.length ? `  missing ${row.missing.join(", ")}` : ""}${row.extra.length ? `  extra ${row.extra.join(", ")}` : ""}`));
  section("test levels the example has and the project lacks", report.missingTestLevels);
  section("test levels the project has and the example lacks", report.extraTestLevels);
  section("test files per level (example / project)", report.testLevels.map((row) => `${row.level}  ${row.expected} / ${row.actual}`));
  return lines.join("\n") + "\n";
}

// --- the command ------------------------------------------------------------------

export const EXAMPLE_ENV = "BOUNDED_EXAMPLE_PROJECT";

export function main(args: readonly string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string } {
  let example = env[EXAMPLE_ENV] ?? "";
  let json = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--example") {
      const value = args[++i];
      if (value === undefined) return { code: 2, out: "structure-compare: --example needs a directory\n" };
      example = value;
    } else if (arg === "--json") json = true;
    else rest.push(arg);
  }
  if (rest.length !== 1) {
    return { code: 2, out: "usage: structure-compare [--example <dir>] [--json] <project>\n" };
  }
  if (example === "") {
    return { code: 2, out: `structure-compare: name the worked example with --example <dir> or ${EXAMPLE_ENV}\n` };
  }
  const report = compareTrees(resolve(example), resolve(rest[0]!));
  return { code: report.deltas === 0 ? 0 : 1, out: json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report) };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const { code, out } = main(process.argv.slice(2));
    process.stdout.write(out);
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`structure-compare: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
