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
//   · tests     the test levels the project's own files require (TN-26-012 §8,
//               ADR 2026-063) that its tests do not reach. Levels are checked
//               against that list, not against the example's tests (the
//               example has almost none): which tests a run writes is its own
//               business, that every required level exists is the structure's.
//
// Known differences the example owns (it is unfinished in places, and has a
// file the product spec does not ask for) are listed in EXPECTED_DELTAS, each
// with its reason; they are reported but not counted, so a faithful run
// reports 0 unexpected deltas.
//
// Harness artifacts (.bounded/, agent instructions, ticket notes, shipped
// check scripts), dependencies, build output and lockfiles are ignored.
// Deterministic: the same two trees always give the same report. Exit 0 when
// there is no unexpected delta, 1 when there is one, 2 on misuse.
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

/** The path with the sole context's name replaced by `<context>` exactly where
 *  a path names the context: the segment directly under `contexts/`, and the
 *  stem of the Drizzle schema namespace file (`schema/<context>.schema.ts`).
 *  An area or a file that merely shares the context's name keeps it. */
export function namedPath(path: string, context: string | undefined): string {
  const segments = path.split("/").map((segment, i, all) => {
    const s = all[i - 1] === "migrations" || all[i - 2] === "migrations" ? migrationName(segment) : segment;
    if (context === undefined || all[0] !== "contexts") return s;
    if (i === 1 && s === context) return "<context>";
    if (i === all.length - 1 && all[i - 1] === "schema" && s === `${context}.schema.ts`) return "<context>.schema.ts";
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

// --- the test levels a tree must have ------------------------------------------------

/**
 * The test levels the project's own files require (TN-26-012 §8, ADR
 * 2026-063), worked out from the project alone: a domain concept needs its
 * unit tests and its generated laws; a feature its handler test, and its
 * command laws when it has a command; a store its feature's conformance suite
 * and a store test per storage technology; any other out adapter its own
 * test; each in-adapter technology its generated laws; each app with a
 * composition root its smoke test; any context the architecture test.
 */
export function requiredTestLevels(files: Iterable<string>): string[] {
  const levels = new Set<string>();
  for (const path of files) {
    const parts = path.split("/");
    if (parts[0] === "apps" && parts.at(-1) === "composition-root.ts") levels.add(`app smoke (${parts[1]})`);
    if (parts[0] !== "contexts" || parts[2] !== "src") continue;
    levels.add("architecture");
    const [layer, a, b, c] = parts.slice(3);
    const name = parts.at(-1)!;
    if (layer === "domain" && a !== "shared" && name.endsWith(".contract.ts")) {
      levels.add("domain unit");
      levels.add("domain laws");
    }
    if (layer === "application" && a !== "shared" && name.endsWith(".contract.ts")) levels.add("handler");
    if (layer === "application" && name.endsWith(".command.ts")) levels.add("command laws");
    if (layer === "adapters" && a === "in" && b !== undefined && c !== undefined) levels.add(`in-adapter laws (${b})`);
    if (layer === "adapters" && a === "out" && b !== undefined && parts.length === 8) {
      if (name.endsWith(".store.ts")) {
        levels.add("store conformance suite");
        levels.add(`store (${b})`);
      } else if (/^[^.]+\.[a-z-]+\.ts$/.test(name) && !name.endsWith(".mapper.ts") &&
        parts[6] !== "schema" && parts[6] !== "migrations") {
        levels.add(`out adapter (${b})`);
      }
    }
  }
  return [...levels].sort(byCodePoint);
}

// --- deltas the worked example owns ------------------------------------------------

/** A structural difference that is known and explained: the worked example is
 *  unfinished in places, and has one file the product spec does not ask for.
 *  A faithful run shows these and no others. Each entry names which side has
 *  the file (`extra`: only the project; `missing`: only the example). */
export interface ExpectedDelta {
  readonly side: "extra" | "missing";
  readonly pattern: RegExp;
  readonly reason: string;
}

const C = String.raw`^contexts\/<context>\/src`;

export const EXPECTED_DELTAS: readonly ExpectedDelta[] = [
  {
    side: "extra",
    pattern: new RegExp(String.raw`${C}\/adapters\/out\/drizzle\/[^/]+\/[^/]+\.store\.ts$`),
    reason: "the example declares Postgres (schema and migrations) but has no Drizzle stores yet; a run that keeps data writes one per store port",
  },
  {
    side: "extra",
    pattern: new RegExp(String.raw`${C}\/adapters\/out\/drizzle\/[^/]+\/[^/]+\.mapper\.ts$`),
    reason: "the example has no Drizzle mappers, because it has no Drizzle stores yet",
  },
  {
    side: "extra",
    pattern: new RegExp(String.raw`${C}\/adapters\/out\/drizzle\/(?:drizzle-database|index)\.ts$`),
    reason: "generated for a context with Drizzle stores (the shared database and the adapter barrel); the example has none yet",
  },
  {
    side: "extra",
    pattern: new RegExp(String.raw`${C}\/domain\/shared\/errors\.ts$`),
    reason: "the red-phase NotImplementedError module; delivery removes it, so it shows only on an undelivered run",
  },
  {
    side: "missing",
    pattern: /^apps\/web\/src\/server\/seed\.ts$/,
    reason: "the example seeds sample projects for local development; the product spec does not ask for it",
  },
];

function expectedReason(side: ExpectedDelta["side"], path: string): string | undefined {
  return EXPECTED_DELTAS.find((entry) => entry.side === side && entry.pattern.test(path))?.reason;
}

// --- the signature and the comparison ----------------------------------------------

export interface TreeSignature {
  /** Named path → exported names (contracts) or null (every other file). */
  readonly files: ReadonlyMap<string, readonly string[] | null>;
  /** Test level → how many test files are at it. */
  readonly testLevels: ReadonlyMap<string, number>;
}

export function signatureOf(root: string): TreeSignature {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
  const all = productFiles(root);
  const context = soleContext(all);
  const files = new Map<string, readonly string[] | null>();
  const testLevels = new Map<string, number>();
  for (const path of all) {
    const named = namedPath(path, context);
    if (TEST_SIDE.test(path) || path === "architecture.test.ts") {
      const level = testLevel(named);
      testLevels.set(level, (testLevels.get(level) ?? 0) + 1);
      continue;
    }
    files.set(named, path.endsWith(".contract.ts") ? exportedNames(readFileSync(join(root, path), "utf8")) : null);
  }
  return { files, testLevels };
}

export interface StructureReport {
  /** Shapes whose count differs, the expected deltas left out of both sides. */
  readonly shapes: readonly { shape: string; expected: number; actual: number }[];
  readonly missingFiles: readonly string[];
  readonly extraFiles: readonly string[];
  readonly contracts: readonly { path: string; missing: readonly string[]; extra: readonly string[] }[];
  /** Levels the project's own files require and its tests do not reach. */
  readonly missingTestLevels: readonly string[];
  /** Known, explained differences: listed, never counted. */
  readonly expectedDeltas: readonly { side: ExpectedDelta["side"]; path: string; reason: string }[];
  /** Test files per level in each tree, for reading only. */
  readonly testLevels: readonly { level: string; expected: number; actual: number }[];
  /** Unexpected deltas: 0 for a run faithful to the example. */
  readonly deltas: number;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function shapeCounts(paths: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) counts.set(shapeOf(path), (counts.get(shapeOf(path)) ?? 0) + 1);
  return counts;
}

export function compareSignatures(expected: TreeSignature, actual: TreeSignature): StructureReport {
  const onlyExpected = [...expected.files.keys()].filter((path) => !actual.files.has(path)).sort(byCodePoint);
  const onlyActual = [...actual.files.keys()].filter((path) => !expected.files.has(path)).sort(byCodePoint);
  const expectedDeltas = [
    ...onlyExpected.flatMap((path) => {
      const reason = expectedReason("missing", path);
      return reason === undefined ? [] : [{ side: "missing" as const, path, reason }];
    }),
    ...onlyActual.flatMap((path) => {
      const reason = expectedReason("extra", path);
      return reason === undefined ? [] : [{ side: "extra" as const, path, reason }];
    }),
  ];
  const explained = new Set(expectedDeltas.map((row) => row.path));
  const missingFiles = onlyExpected.filter((path) => !explained.has(path));
  const extraFiles = onlyActual.filter((path) => !explained.has(path));

  const expectedShapes = shapeCounts([...expected.files.keys()].filter((path) => !explained.has(path)));
  const actualShapes = shapeCounts([...actual.files.keys()].filter((path) => !explained.has(path)));
  const shapes = [...new Set([...expectedShapes.keys(), ...actualShapes.keys()])].sort(byCodePoint)
    .map((shape) => ({ shape, expected: expectedShapes.get(shape) ?? 0, actual: actualShapes.get(shape) ?? 0 }))
    .filter((row) => row.expected !== row.actual);

  const contracts = [...expected.files.entries()]
    .filter(([path, names]) => names !== null && actual.files.get(path) != null)
    .map(([path, names]) => {
      const theirs = actual.files.get(path)!;
      return { path, missing: names!.filter((n) => !theirs.includes(n)), extra: theirs.filter((n) => !names!.includes(n)) };
    })
    .filter((row) => row.missing.length > 0 || row.extra.length > 0)
    .sort((a, b) => byCodePoint(a.path, b.path));

  const missingTestLevels = requiredTestLevels(actual.files.keys()).filter((level) => !actual.testLevels.has(level));
  const levelKeys = [...new Set([...expected.testLevels.keys(), ...actual.testLevels.keys()])].sort(byCodePoint);
  const testLevels = levelKeys.map((level) => ({
    level, expected: expected.testLevels.get(level) ?? 0, actual: actual.testLevels.get(level) ?? 0,
  }));
  const deltas = shapes.length + missingFiles.length + extraFiles.length + contracts.length + missingTestLevels.length;
  return { shapes, missingFiles, extraFiles, contracts, missingTestLevels, expectedDeltas, testLevels, deltas };
}

export function compareTrees(exampleRoot: string, projectRoot: string): StructureReport {
  return compareSignatures(signatureOf(exampleRoot), signatureOf(projectRoot));
}

export function formatReport(report: StructureReport): string {
  const lines: string[] = [];
  const expected = report.expectedDeltas.length === 0 ? "" : ` (${report.expectedDeltas.length} expected, listed below)`;
  lines.push(report.deltas === 0
    ? `structure: 0 unexpected structural deltas against the example${expected}`
    : `structure: ${report.deltas} unexpected structural delta(s) against the example${expected}`);
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
  section("test levels the project's files require and its tests lack", report.missingTestLevels);
  section("expected deltas, owned by the example", report.expectedDeltas.map((row) =>
    `${row.side === "extra" ? "project only" : "example only"}  ${row.path} — ${row.reason}`));
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
