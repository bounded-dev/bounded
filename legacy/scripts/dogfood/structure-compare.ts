// dogfood structure-compare — how far a dogfood run's tree is from the
// hexagonal monorepo conventions, or from a worked example's tree.
//
//   node scripts/dogfood/structure-compare.ts [--json] <project>
//   node scripts/dogfood/structure-compare.ts --example <dir> [--json] <project>
//
// With no example named (neither --example nor BOUNDED_EXAMPLE_PROJECT), or
// with --conventions, the project is judged against the conventions alone
// (TN-26-012), so a run of any product can be scored and copying the worked
// example's file list earns nothing. The findings are:
//
//   · layout        the root config; nothing outside contexts/ and apps/
//                   but ROOT_FILES, docs/ and scripts/; each context's
//                   generated barrels and result.ts; nothing in a context
//                   outside domain/<area>/<concept>, application/<area>/
//                   <feature>, adapters/in|out/<technology>/; exactly the
//                   root files TN-26-012 §6 gives each in technology
//                   (IN_TECH_ROOT_FILES); each out technology's barrel, and
//                   each storage technology's <tech>-database.ts; an app's
//                   manifest and src/ only;
//   · naming        kebab-case names, plural areas, two-word features, files
//                   named for their feature, the role suffixes of each layer,
//                   the in port and store names a contract must export, one
//                   feature role per in technology;
//   · feature files each concept's and feature's file set as its contract
//                   calls for it: a handler, a command iff the contract has an
//                   Input; when it has a store port, a store in every storage
//                   technology the project composes (.bounded/composed-
//                   packs.json; with none recorded, every known storage
//                   technology whose folder the context has, or any folder
//                   with a <tech>-database.ts); an adapter per @exposedVia and
//                   @implementedBy technology; and no adapter for a feature
//                   or port that does not exist, nor an in adapter its
//                   feature's @exposedVia does not name;
//   · test levels   every required level, file by file (TN-26-012 §8, ADR
//                   2026-063): unit tests and laws per concept, a handler
//                   test per feature, command laws, the store conformance
//                   suite and a store test per store, a test per other out
//                   adapter, generated laws per in adapter, a smoke test
//                   beside every composition root, the architecture test;
//   · apps          each app's template files by its kind (declared in a
//                   TN's workspaces map, else recognised by its files), and a
//                   Lambda app's one entry per Lambda in adapter.
//
// With an example, the report says, for the project against the example:
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
// Deterministic: the same trees always give the same report. Exit 0 when
// there is no finding or unexpected delta, 1 when there is one, 2 on misuse.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pascalCase, portRole } from "../../agent/packs/ts/scripts/naming.ts";

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

// --- the conventions alone ----------------------------------------------------------
//
// With no worked example named, a project is judged against the conventions
// themselves (TN-26-012 §1, §2, §7, §8, the app templates of §10): what files
// its own contracts call for, whatever the product. Every rule reads only the
// project's tree, its contracts' exported names and tags, the composed
// technologies' feature roles (the packs' contrib.json), and the app kinds
// its TNs declare; a run of any product can pass it, and a run that copied
// the example's file list gains nothing from it.

/** What a convention finding is about, in the report's order. */
export const CONVENTION_RULES = ["layout", "naming", "feature files", "test levels", "apps"] as const;
export type ConventionRule = (typeof CONVENTION_RULES)[number];

export interface ConventionFinding {
  readonly rule: ConventionRule;
  readonly path: string;
  readonly message: string;
}

export interface ConventionsReport {
  readonly findings: readonly ConventionFinding[];
  /** What the project's tree declares, for reading only. */
  readonly inventory: {
    readonly contexts: readonly string[];
    readonly concepts: number;
    readonly features: number;
    readonly apps: readonly { app: string; kind: string }[];
  };
  /** Findings: 0 for a project that follows the conventions. */
  readonly deltas: number;
}

/** The adapter technologies the packs declare: in technologies' feature roles,
 *  out technologies' storage flag, and which pack declares each. Unknown
 *  technologies are judged by what the tree shows (a `<tech>-database.ts`
 *  makes storage; one role per in folder). */
export interface KnownTechnologies {
  readonly featureRoles: ReadonlyMap<string, string>;
  readonly storage: ReadonlyMap<string, boolean>;
  readonly packOf: ReadonlyMap<string, string>;
}

const PACKS_DIR = resolve(new URL(".", import.meta.url).pathname, "../../agent/packs");

export function packTechnologies(packsDir: string = PACKS_DIR): KnownTechnologies {
  const featureRoles = new Map<string, string>();
  const storage = new Map<string, boolean>();
  const packOf = new Map<string, string>();
  if (!existsSync(packsDir)) return { featureRoles, storage, packOf };
  for (const pack of readdirSync(packsDir).sort()) {
    const contrib = join(packsDir, pack, "contrib.json");
    if (!existsSync(contrib)) continue;
    const parsed = JSON.parse(readFileSync(contrib, "utf8")) as { adapterTechnologies?: unknown };
    if (!Array.isArray(parsed.adapterTechnologies)) continue;
    for (const tech of parsed.adapterTechnologies as { id?: unknown; direction?: unknown; featureRole?: unknown; storage?: unknown }[]) {
      if (typeof tech.id !== "string") continue;
      packOf.set(tech.id, pack);
      if (tech.direction === "in" && typeof tech.featureRole === "string") featureRoles.set(tech.id, tech.featureRole);
      if (tech.direction === "out") storage.set(tech.id, tech.storage === true);
    }
  }
  return { featureRoles, storage, packOf };
}

/** The packs the project composes (`.bounded/composed-packs.json`, written by
 *  `bounded init` and `bounded compose`), or undefined when it records none. */
export function composedPacks(root: string): string[] | undefined {
  const path = join(root, ".bounded", "composed-packs.json");
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : undefined;
}

/**
 * The files TN-26-012 §6 puts at the top of each in technology's folder
 * (`adapters/in/<tech>/`), beside its `<area>/` folders; an unknown
 * technology has only its barrel. A test holds this table to the in-adapter
 * emitters' output.
 */
export const IN_TECH_ROOT_FILES: Readonly<Record<string, readonly string[]>> = {
  trpc: ["index.ts", "router.ts", "trpc.ts"],
  mcp: ["index.ts", "server.ts"],
  lambda: ["index.ts"],
};

/** Root files outside `contexts/` and `apps/` that a project may hold: the
 *  generated and config files of TN-26-012 §1, and its readme. `docs/` holds
 *  prose and the generated rulebook; `scripts/` is shipped by the harness. */
export const ROOT_FILES: readonly string[] = [
  ".env.example", ".gitignore", ".npmrc", "README.md", "architecture.test.ts", "bunfig.toml", "docker-compose.yml",
  "package.json", "tsconfig.base.json", "tsconfig.json",
];
const ROOT_DIRS: readonly string[] = ["docs/", "scripts/"];

/**
 * The files each app kind's template seeds (the app packs' emitters), beyond
 * its `package.json`. A Lambda app also has one `src/<feature>.ts` entry per
 * feature with a Lambda in adapter. `marker` is how the kind is recognised
 * when no TN declares it: the file only that kind has. A test holds this
 * table to the app emitters' output, so it cannot drift from them.
 */
export const APP_TEMPLATES: Readonly<Record<string, { files: readonly string[]; marker: string }>> = {
  web: {
    files: ["src/client/index.html", "src/client/main.tsx", "src/server/composition-root.ts", "src/server/main.ts"],
    marker: "src/server/",
  },
  desktop: {
    files: ["src/main/composition-root.ts", "src/main/main.ts", "src/renderer/index.html", "src/renderer/main.tsx"],
    marker: "src/renderer/",
  },
  mcp: { files: ["src/composition-root.ts", "src/main.ts"], marker: "src/main.ts" },
  lambdas: { files: ["src/composition-root.ts"], marker: "src/composition-root.ts" },
};

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const isKebab = (name: string): boolean => KEBAB.test(name);
const pascal = (kebab: string): string => (isKebab(kebab) ? pascalCase(kebab) : kebab);
const plural = (noun: string): boolean => noun.endsWith("s");

/** The apps the project's TNs declare (`workspaces:` front matter, TN-26-012 §9). */
export function declaredAppKinds(root: string): Map<string, string> {
  const kinds = new Map<string, string>();
  const dir = join(root, "docs", "tn");
  if (!existsSync(dir)) return kinds;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const lines = readFileSync(join(dir, name), "utf8").split("\n");
    if (lines[0]?.trim() !== "---") continue;
    let inBlock = false;
    for (const line of lines.slice(1)) {
      if (line.trim() === "---") break;
      if (line === "workspaces:") { inBlock = true; continue; }
      const entry = /^ {2}(apps\/[a-z0-9][a-z0-9-]*): ([a-z][a-z0-9-]*)$/.exec(line);
      if (inBlock && entry) kinds.set(entry[1]!, entry[2]!);
      else inBlock = false;
    }
  }
  return kinds;
}

/** The JSDoc tags on each exported interface of a contract. */
export function interfaceTags(source: string): Map<string, { exposedVia: string[]; implementedBy: string[] }> {
  const tags = new Map<string, { exposedVia: string[]; implementedBy: string[] }>();
  for (const match of source.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*export\s+interface\s+([A-Za-z_$][\w$]*)/g)) {
    const ids = (tag: string): string[] =>
      [...match[1]!.matchAll(new RegExp(String.raw`^\s*\*\s*@${tag}((?:[ \t]+[a-z][a-z0-9-]*)+)[ \t]*$`, "gm"))]
        .flatMap((m) => m[1]!.trim().split(/\s+/));
    tags.set(match[2]!, { exposedVia: ids("exposedVia"), implementedBy: ids("implementedBy") });
  }
  return tags;
}

interface Feature {
  readonly area: string;
  readonly feature: string;
  readonly dir: string;
  readonly files: Set<string>;
  inPort?: string;
  input?: boolean;
  store?: boolean;
  /** Other out ports' roles → the technologies tagged to implement them (null: untagged). */
  otherPorts?: Map<string, string[] | null>;
  /** The in technologies tagged, or null when the in port has no tag. */
  exposedVia?: string[] | null;
}

/** Judge a project against the conventions alone. */
export function checkConventions(root: string, known: KnownTechnologies = packTechnologies()): ConventionsReport {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
  const all = productFiles(root);
  const has = new Set(all);
  const findings: ConventionFinding[] = [];
  const add = (rule: ConventionRule, path: string, message: string): void => { findings.push({ rule, path, message }); };
  const need = (rule: ConventionRule, path: string, why: string): void => { if (!has.has(path)) add(rule, path, `missing: ${why}`); };
  const read = (path: string): string => readFileSync(join(root, path), "utf8");

  for (const file of ["package.json", "tsconfig.json", "tsconfig.base.json"]) need("layout", file, "the monorepo's root config");
  for (const path of all) {
    if (path.startsWith("contexts/") || path.startsWith("apps/") || ROOT_FILES.includes(path) ||
      ROOT_DIRS.some((dir) => path.startsWith(dir))) continue;
    add("layout", path, "code lives in contexts/ and apps/; the root holds only its config and generated files");
  }

  // Storage: the composed storage technologies, or, with no composition
  // recorded, the known storage technologies whose folder the context has.
  const composed = composedPacks(root);
  const storageTechs = (contextOutTechs: readonly string[]): string[] => [...known.storage]
    .filter(([id, storage]) => storage &&
      (composed !== undefined ? composed.includes(known.packOf.get(id) ?? "") : contextOutTechs.includes(id)))
    .map(([id]) => id);

  // Names: every folder and file stem under a context or an app's source root
  // is kebab-case (generated migration names excepted).
  for (const path of all) {
    const parts = path.split("/");
    if (!(parts[0] === "contexts" || (parts[0] === "apps" && parts[2] === "src"))) continue;
    const migrations = parts.indexOf("migrations");
    parts.forEach((segment, i) => {
      if (i === 0 || (migrations >= 0 && i > migrations)) return;
      const stem = i === parts.length - 1 ? roleSuffix(segment).stem : segment;
      if (!isKebab(stem)) add("naming", path, `'${stem}' is not kebab-case`);
    });
  }

  const contexts = [...new Set(all.filter((f) => f.startsWith("contexts/")).map((f) => f.split("/")[1]!))].sort(byCodePoint);
  const lambdaFeatures = new Set<string>();
  let conceptCount = 0;
  let featureCount = 0;
  for (const context of contexts) {
    const base = `contexts/${context}`;
    const files = all.filter((f) => f.startsWith(`${base}/`)).map((f) => f.slice(base.length + 1));
    const at = (rel: string): string => `${base}/${rel}`;
    for (const rel of ["package.json", "src/domain/index.ts", "src/domain/shared/result.ts", "src/application/index.ts"]) {
      need("layout", at(rel), "every context has it");
    }
    need("test levels", "architecture.test.ts", "the architecture test, at the root of any project with a context");

    const concepts = new Map<string, Set<string>>(); // "area/concept" → suffixes
    const features = new Map<string, Feature>();    // "area/feature" → feature
    const inFiles: { tech: string; rel: string; parts: string[] }[] = [];
    const outFiles: { tech: string; rel: string; parts: string[] }[] = [];

    for (const rel of files) {
      const parts = rel.split("/");
      const name = parts.at(-1)!;
      const { stem, suffix } = roleSuffix(name);
      if (rel === "package.json" || rel === "drizzle.config.ts") continue;
      if (parts[0] !== "src") { add("layout", at(rel), "a context holds only its manifest, its generated config and src/"); continue; }
      const [layer, a, b, c] = parts.slice(1);
      if (layer === "domain") {
        if (rel === "src/domain/index.ts" || rel === "src/domain/shared/result.ts" || rel === "src/domain/shared/errors.ts") continue;
        if (a === "shared" || parts.length !== 4) { add("layout", at(rel), "the domain holds <area>/<concept> files, the barrel and shared/result.ts"); continue; }
        if (![".contract.ts", ".ts", ".test.ts", ".laws.test.ts"].includes(suffix)) {
          add("naming", at(rel), `'${suffix}' is not a domain role suffix (.contract.ts, .ts, .test.ts, .laws.test.ts)`);
          continue;
        }
        const key = `${a}/${stem}`;
        if (!concepts.has(key)) concepts.set(key, new Set());
        concepts.get(key)!.add(suffix);
      } else if (layer === "application") {
        if (rel === "src/application/index.ts") continue;
        if (a === "shared" || parts.length !== 5) { add("layout", at(rel), "the application holds <area>/<feature>/<feature>.<role>.ts files and the barrel"); continue; }
        const key = `${a}/${b}`;
        if (!features.has(key)) features.set(key, { area: a!, feature: b!, dir: `src/application/${a}/${b}`, files: new Set() });
        if (stem !== b) { add("naming", at(rel), `a feature's files are named for the feature: '${b}${suffix}'`); continue; }
        const roles = [".contract.ts", ".command.ts", ".handler.ts", ".test.ts", ".command.laws.test.ts", ".store.test-support.ts"];
        if (!roles.includes(suffix)) { add("naming", at(rel), `'${suffix}' is not a feature role suffix (${roles.join(", ")})`); continue; }
        features.get(key)!.files.add(suffix);
      } else if (layer === "adapters" && (a === "in" || a === "out") && b !== undefined && c !== undefined) {
        (a === "in" ? inFiles : outFiles).push({ tech: b, rel, parts: parts.slice(4) });
      } else {
        add("layout", at(rel), "a context's src/ holds domain/, application/ and adapters/in|out/<technology>/");
      }
    }

    // Areas and features.
    const areas = new Set([...concepts.keys(), ...features.keys()].map((key) => key.split("/")[0]!));
    for (const area of [...areas].sort(byCodePoint)) {
      if (!plural(area)) add("naming", at(`src/*/${area}`), `an area is a plural business noun: '${area}'`);
    }
    const conceptNames = new Set([...concepts.keys()].map((key) => key.split("/")[1]!));

    // Domain concepts: contract, implementation, unit tests and laws.
    for (const [key, suffixes] of [...concepts].sort(([x], [y]) => byCodePoint(x, y))) {
      const stemPath = at(`src/domain/${key}`);
      if (!suffixes.has(".contract.ts")) { add("feature files", `${stemPath}.contract.ts`, "missing: every domain file belongs to a concept with a contract"); continue; }
      conceptCount++;
      const concept = key.split("/")[1]!;
      if (!exportedNames(read(`${stemPath}.contract.ts`)).includes(pascal(concept))) {
        add("naming", `${stemPath}.contract.ts`, `a concept's contract exports the concept, '${pascal(concept)}'`);
      }
      need("feature files", `${stemPath}.ts`, "the concept's implementation");
      need("test levels", `${stemPath}.test.ts`, "domain unit tests");
      need("test levels", `${stemPath}.laws.test.ts`, "the concept's generated laws");
    }

    // Features: contract, handler, command iff input, tests per port.
    for (const [key, feature] of [...features].sort(([x], [y]) => byCodePoint(x, y))) {
      const file = (suffix: string): string => at(`${feature.dir}/${feature.feature}${suffix}`);
      if (feature.feature.split("-").length < 2) add("naming", at(feature.dir), `a feature is verb-first and at least two words: '${feature.feature}'`);
      if (!feature.files.has(".contract.ts")) { add("feature files", file(".contract.ts"), "missing: every feature folder has its contract"); continue; }
      featureCount++;
      const source = read(file(".contract.ts"));
      const names = exportedNames(source);
      const tags = interfaceTags(source);
      const inPort = pascal(feature.feature);
      feature.inPort = inPort;
      if (!names.includes(inPort)) add("naming", file(".contract.ts"), `a feature's contract exports its in port, '${inPort}'`);
      const command = [`${inPort}Input`, `${inPort}Command`, `${inPort}CommandFactory`].map((n) => names.includes(n));
      if (command.some(Boolean) && !command.every(Boolean)) {
        add("naming", file(".contract.ts"), `${inPort}Input, ${inPort}Command and ${inPort}CommandFactory are all present or all absent`);
      }
      feature.input = command[0];
      feature.store = names.includes(`${inPort}Store`);
      const others = names.filter((n) => n !== inPort && n !== `${inPort}Input` && n !== `${inPort}Command` &&
        n !== `${inPort}CommandFactory` && n !== `${inPort}Store`);
      feature.otherPorts = new Map();
      for (const port of others) {
        if (port.endsWith("Store")) { add("naming", file(".contract.ts"), `'${port}': the store port is exactly '${inPort}Store'; other ports must not end in Store`); continue; }
        const implementedBy = tags.get(port)?.implementedBy ?? [];
        feature.otherPorts.set(portRole(port), implementedBy.length > 0 ? implementedBy : null);
      }
      const exposed = tags.get(inPort)?.exposedVia ?? [];
      feature.exposedVia = exposed.length > 0 ? exposed : null;

      need("feature files", file(".handler.ts"), "every feature has its handler");
      need("test levels", file(".test.ts"), "the handler test");
      if (feature.input) {
        need("feature files", file(".command.ts"), "a feature that takes input has its generated command");
        need("test levels", file(".command.laws.test.ts"), "the command's generated laws");
      } else {
        if (feature.files.has(".command.ts")) add("feature files", file(".command.ts"), "a command file without an Input in the contract");
        if (feature.files.has(".command.laws.test.ts")) add("feature files", file(".command.laws.test.ts"), "command laws without an Input in the contract");
      }
      if (feature.store) need("test levels", file(".store.test-support.ts"), "the store port's conformance suite");
      else if (feature.files.has(".store.test-support.ts")) add("feature files", file(".store.test-support.ts"), `a conformance suite without a ${inPort}Store port`);
      for (const tech of feature.exposedVia ?? []) {
        if (tech === "lambda") lambdaFeatures.add(feature.feature);
        const role = known.featureRoles.get(tech);
        const prefix = `src/adapters/in/${tech}/${feature.area}/${feature.feature}.`;
        const found = role !== undefined ? files.includes(`${prefix}${role}.ts`)
          : files.some((f) => f.startsWith(prefix) && !f.endsWith(".test.ts"));
        if (!found) add("feature files", at(`${prefix}${role ?? "<role>"}.ts`), `missing: the in adapter its @exposedVia ${tech} calls for`);
      }
      for (const [role, techs] of feature.otherPorts) {
        for (const tech of techs ?? []) need("feature files", at(`src/adapters/out/${tech}/${feature.area}/${feature.feature}.${role}.ts`), `the adapter its @implementedBy ${tech} calls for`);
      }
    }

    // In adapters: generated per feature, one role per technology, laws beside.
    const inTechs = [...new Set(inFiles.map((f) => f.tech))].sort(byCodePoint);
    for (const tech of inTechs) {
      const rootFiles = IN_TECH_ROOT_FILES[tech] ?? ["index.ts"];
      for (const file of rootFiles) need("layout", at(`src/adapters/in/${tech}/${file}`), `a generated root file of in/${tech}/`);
      const role = known.featureRoles.get(tech);
      const roles = new Set<string>();
      for (const { rel, parts } of inFiles.filter((f) => f.tech === tech)) {
        if (parts.length === 1) {
          if (!rootFiles.includes(parts[0]!)) add("layout", at(rel), `the top of in/${tech}/ holds only ${rootFiles.join(", ")}`);
          continue;
        }
        if (parts.length !== 2) { add("layout", at(rel), "an in adapter lives at in/<technology>/<area>/<feature>.<role>.ts"); continue; }
        const [area, name] = parts as [string, string];
        const { stem, suffix } = roleSuffix(name);
        if (stem === area && suffix.endsWith(".ts") && !suffix.includes(".test")) continue; // the area's aggregate (a router)
        const feature = features.get(`${area}/${stem}`);
        if (feature === undefined) { add("feature files", at(rel), `'${area}/${stem}' is not a feature of this context`); continue; }
        const laws = /^\.([a-z][a-z0-9-]*)\.laws\.test\.ts$/.exec(suffix);
        const main = /^\.([a-z][a-z0-9-]*)\.ts$/.exec(suffix);
        if (laws) continue;
        if (!main) { add("layout", at(rel), "under in/ only generated adapters and their generated laws"); continue; }
        roles.add(main[1]!);
        if (role !== undefined && main[1] !== role) add("naming", at(rel), `${tech}'s feature role is '${role}', not '${main[1]}'`);
        if (!(feature.exposedVia ?? []).includes(tech)) add("feature files", at(rel), `the feature's contract has no @exposedVia ${tech}`);
        if (tech === "lambda") lambdaFeatures.add(stem);
        need("test levels", at(rel.replace(/\.ts$/, ".laws.test.ts")), "the in adapter's generated laws");
      }
      if (role === undefined && roles.size > 1) add("naming", at(`src/adapters/in/${tech}`), `one feature role per in technology, not ${[...roles].sort(byCodePoint).join(", ")}`);
    }

    // Out adapters. When the design keeps data (a feature has a store port),
    // every composed storage technology implements every store port, beside
    // its shared database; other roles follow their tags.
    const outTechs = [...new Set(outFiles.map((f) => f.tech))].sort(byCodePoint);
    const storeFeatures = [...features.values()].filter((f) => f.store);
    const storages = new Set([
      ...(storeFeatures.length > 0 ? storageTechs(outTechs) : []),
      ...outTechs.filter((tech) => outFiles.some((f) => f.tech === tech && f.parts.join("/") === `${tech}-database.ts`)),
    ]);
    for (const tech of [...new Set([...outTechs, ...storages])].sort(byCodePoint)) {
      const techFiles = outFiles.filter((f) => f.tech === tech);
      const database = `${tech}-database.ts`;
      const inUse = storages.has(tech) ||
        techFiles.some((f) => f.parts.length === 2 && f.parts[0] !== "schema" && f.parts[0] !== "migrations");
      if (inUse) need("layout", at(`src/adapters/out/${tech}/index.ts`), "every out technology with adapters has its barrel");
      if (storages.has(tech)) {
        need("layout", at(`src/adapters/out/${tech}/${database}`), "a storage technology's shared database");
        for (const feature of storeFeatures) {
          const store = `src/adapters/out/${tech}/${feature.area}/${feature.feature}.store.ts`;
          need("feature files", at(store), `${feature.inPort}Store, once per storage technology (composed, or present when no composition is recorded)`);
          need("test levels", at(store.replace(/\.ts$/, ".test.ts")), "the store test, running the conformance suite");
        }
      }
      for (const { rel, parts } of techFiles) {
        const top = parts[0]!;
        if (parts.length === 1) {
          if (top === "index.ts" || top === database || top === `${tech}-test-database.test-support.ts`) continue;
          add("layout", at(rel), `an out technology's top level holds index.ts and ${database}`);
          continue;
        }
        if (top === "migrations") continue;
        if (top === "schema") {
          const { stem, suffix } = roleSuffix(parts[1]!);
          if (parts.length !== 2) add("layout", at(rel), "schema/ holds one file per area and the context's namespace file");
          else if (suffix === ".schema.ts" ? stem !== context : suffix !== ".ts" || !areas.has(stem)) {
            add("naming", at(rel), `schema/ holds ${context}.schema.ts and one <area>.ts per area of this context`);
          }
          continue;
        }
        if (parts.length !== 2) { add("layout", at(rel), "an out adapter lives at out/<technology>/<area>/<feature>.<role>.ts"); continue; }
        const [area, name] = parts as [string, string];
        const { stem, suffix } = roleSuffix(name);
        if (suffix === ".mapper.ts") {
          if (!conceptNames.has(stem)) add("naming", at(rel), `a mapper is named for a domain concept, and '${stem}' is not one`);
          continue;
        }
        const feature = features.get(`${area}/${stem}`);
        if (feature === undefined) { add("feature files", at(rel), `'${area}/${stem}' is not a feature of this context`); continue; }
        const role = /^\.([a-z][a-z0-9-]*)\.(?:test\.)?ts$/.exec(suffix)?.[1];
        if (role === undefined) { add("naming", at(rel), `'${suffix}' is not an out adapter role suffix (.<role>.ts, .<role>.test.ts, .mapper.ts)`); continue; }
        if (suffix.endsWith(".test.ts")) {
          if (!has.has(at(rel.replace(/\.test\.ts$/, ".ts")))) add("feature files", at(rel), "a test without the adapter it tests");
          continue;
        }
        if (role === "store") {
          if (!feature.store) add("feature files", at(rel), `a store without a ${feature.inPort}Store port`);
          continue;
        }
        const techs = feature.otherPorts?.get(role);
        if (techs === undefined) add("naming", at(rel), `'${role}' is not the role of any out port of ${feature.inPort}`);
        else if (techs !== null && !techs.includes(tech)) add("feature files", at(rel), `the port's @implementedBy does not name ${tech}`);
        need("test levels", at(rel.replace(/\.ts$/, ".test.ts")), "the out adapter's test");
      }
    }
  }

  // Apps: each kind's seeded files, a smoke test beside every composition root.
  const declared = declaredAppKinds(root);
  const appDirs = [...new Set(all.filter((f) => f.startsWith("apps/") && f.split("/").length > 2).map((f) => f.split("/").slice(0, 2).join("/")))].sort(byCodePoint);
  const apps: { app: string; kind: string }[] = [];
  for (const app of appDirs) {
    const files = all.filter((f) => f.startsWith(`${app}/`)).map((f) => f.slice(app.length + 1));
    const inferred = Object.entries(APP_TEMPLATES).find(([, t]) => files.some((f) => f.startsWith(t.marker)))?.[0];
    const kind = declared.get(app) ?? inferred;
    apps.push({ app, kind: kind ?? "unknown" });
    need("apps", `${app}/package.json`, "every app is a workspace with its manifest");
    for (const rel of files) if (rel !== "package.json" && !rel.startsWith("src/")) add("layout", `${app}/${rel}`, "an app holds its manifest and src/");
    for (const rel of files.filter((f) => f.endsWith("/composition-root.ts") || f === "src/composition-root.ts")) {
      need("test levels", `${app}/${rel.replace(/\.ts$/, ".test.ts")}`, "the app's smoke test, beside its composition root");
    }
    const template = kind === undefined ? undefined : APP_TEMPLATES[kind];
    if (template === undefined) { add("apps", app, kind === undefined ? "no TN declares its kind and its files match no app template" : `'${kind}' is not a known app kind`); continue; }
    for (const rel of template.files) need("apps", `${app}/${rel}`, `a ${kind} app's seeded file`);
    if (kind === "lambdas") {
      for (const feature of [...lambdaFeatures].sort(byCodePoint)) need("apps", `${app}/src/${feature}.ts`, "one entry per Lambda in adapter");
      for (const rel of files) {
        const entry = /^src\/([^/.]+)\.ts$/.exec(rel)?.[1];
        if (entry !== undefined && entry !== "composition-root" && !lambdaFeatures.has(entry)) add("apps", `${app}/${rel}`, "a Lambda entry with no Lambda in adapter");
      }
    }
  }

  const unique = new Map(findings.map((f) => [`${f.rule}\0${f.path}\0${f.message}`, f]));
  const sorted = [...unique.values()].sort((x, y) =>
    CONVENTION_RULES.indexOf(x.rule) - CONVENTION_RULES.indexOf(y.rule) || byCodePoint(x.path, y.path) || byCodePoint(x.message, y.message));
  return {
    findings: sorted,
    inventory: { contexts, concepts: conceptCount, features: featureCount, apps },
    deltas: sorted.length,
  };
}

export function formatConventionsReport(report: ConventionsReport): string {
  const { contexts, concepts, features, apps } = report.inventory;
  const lines = [
    report.deltas === 0
      ? "structure: 0 convention findings (judged against TN-26-012, no worked example)"
      : `structure: ${report.deltas} convention finding(s) (judged against TN-26-012, no worked example)`,
    "",
    `inventory: ${contexts.length} context(s) [${contexts.join(", ")}], ${concepts} concept(s), ${features} feature(s), ` +
      `${apps.length} app(s) [${apps.map((a) => `${a.app.slice(5)}: ${a.kind}`).join(", ")}]`,
  ];
  for (const rule of CONVENTION_RULES) {
    const rows = report.findings.filter((f) => f.rule === rule);
    if (rows.length > 0) lines.push("", `${rule}:`, ...rows.map((f) => `  ${f.path} — ${f.message}`));
  }
  return lines.join("\n") + "\n";
}

// --- the command ------------------------------------------------------------------

export const EXAMPLE_ENV = "BOUNDED_EXAMPLE_PROJECT";

export function main(args: readonly string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string } {
  let example = env[EXAMPLE_ENV] ?? "";
  let json = false;
  let conventions = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--example") {
      const value = args[++i];
      if (value === undefined) return { code: 2, out: "structure-compare: --example needs a directory\n" };
      example = value;
    } else if (arg === "--conventions") conventions = true;
    else if (arg === "--json") json = true;
    else rest.push(arg);
  }
  if (rest.length !== 1) {
    return { code: 2, out: "usage: structure-compare [--example <dir> | --conventions] [--json] <project>\n" };
  }
  if (conventions || example === "") {
    const report = checkConventions(resolve(rest[0]!));
    return { code: report.deltas === 0 ? 0 : 1, out: json ? JSON.stringify(report, null, 2) + "\n" : formatConventionsReport(report) };
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
