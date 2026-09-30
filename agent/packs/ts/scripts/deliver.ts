// Delivery pass (TN-26-001): finished run → repo you would hand a colleague.
//
//   node deliver.ts [targetDir]
//
// The developer stage leaves the target correct but harness-shaped: red-phase
// scaffolding (shared/errors.ts), __conformance blobs, no package entry point,
// and nothing that keeps contract/implementation alignment honest once the
// harness is gone. This pass is mechanical — it decides nothing about the
// design; it only removes what the loop needed and ships what a colleague
// needs. Steps, in order, each logging one guard event and printing one line:
//
//   1. scaffolding    delete src/shared/errors.ts iff nothing in src/ imports
//                     it (ts-morph, not grep). A surviving import of
//                     NotImplementedError is a BLOCK: an unimplemented export
//                     reached delivery. Imports from tests/ only ⇒ keep it.
//   2. shadow         remove .bounded/shadow-red/, the throwaway project red_gate
//                     rebuilds to prove red in. It is a second copy of the
//                     contracts, the skeletons and the whole tests tree — a
//                     reader who found it would reasonably wonder which copy
//                     is the real one.
//   3. conformance    strip the trailing `const __conformance: typeof
//                     __Contract = {…}; void __conformance;` blob and the
//                     `import type * as __Contract` line from each
//                     implementation (the shipped surface check replaces
//                     them). `export type * from "./x.contract.js"` stays —
//                     it is load-bearing for interface/type-alias exports.
//   4. barrel         generate src/index.ts, one `export *` per
//                     contract-implementation pair. A pre-existing index.ts
//                     the run produced is a BLOCK — merging is a design act.
//   5. surface check  ship scripts/surface-check.ts into the target, add
//                     `check:surface` to package.json, fold it into `check`,
//                     pin ts-morph (the pack's own version) AND install it.
//                     A pin nobody installed is a repo whose check dies with
//                     ERR_MODULE_NOT_FOUND, so a failed install is a BLOCK.
//                     In a project whose config the packs generate
//                     (ADR 2026-054), steps 5, 5b and 5c change nothing: the
//                     manifest must already carry it all, and anything
//                     missing is a BLOCK. The drift check runs again last.
//   6. gitignore      ensure `.bounded/` is ignored.
//   7. README         add a "## Contracts" section for a reader who has
//                     never seen the convention.
//   8. timing         READ-ONLY: print where the run's minutes went, from the
//                     project's own guard log (issue #13). Measure before
//                     optimizing further — and the run that just finished is
//                     the only one whose numbers nobody has to remember.
//   9. check          READ-ONLY, and last of deliver's own steps: run the
//                     project's OWN canonical `npm run check` and BLOCK if it
//                     is red. Every other step is deliver's opinion of a
//                     finished repo; this one asks the repo whether it
//                     satisfies its own definition of done. r15 handed over two
//                     repos whose check was red on arrival, because nothing in
//                     the pipeline had ever run it (green_gate runs its own tsc
//                     and vitest — not the command a colleague types).
//  10. pack checks    READ-ONLY, and LAST: every check contributed to this
//                     pack's `deliverChecks` socket (ADR 2026-033), in
//                     composition order. A pack that ships a reference set into
//                     a tree has claims about the delivered repo that no lint
//                     rule can check, because they are about files the PROJECT
//                     owns — ts-web's theme gate is the first. A block stops
//                     delivery like any other step; a check that throws is a
//                     block naming the check, because a check that crashed
//                     verified nothing.
//
// Idempotent: every step checks before acting; a second run applies 0 steps
// (steps 8, 9 and 10 only read, so they never count as applied).
// Exit 0 delivered · 1 block · 2 misuse (bad target / missing checker
// source). The checker source is injectable for tests via options or
// BOUNDED_DELIVER_SURFACE_CHECK (the real file is packs/ts/scripts/surface-check.ts);
// so is the npm runner steps 5 and 9 spawn (DeliverOptions.run).

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Node, Project } from "ts-morph";
import { logGuardEvent, readGuardLog, type GuardVerdict } from "../../../src/guard-log.ts";
import {
  formatPhaseDurations,
  phaseDurations,
  type PhaseDurations,
} from "../../../src/phase-durations.ts";
import { composedPacks } from "../../installed.ts";
import { contractSupportFiles, deliverChecks, type DeliverCheckResult } from "../pack.ts";
import { findContractFiles } from "./checksum-gate.ts";
import { configDriftBlock, configIsGenerated, SYNC_COMMAND } from "./project-config.ts";
import { SHADOW_RELATIVE } from "./red-gate.ts";
import { skeletonSiblingPaths } from "./scaffold-contract.ts";
import {
  ERRORS_REL,
  errorsImportsOf,
  findSkeletonImportsInSrc,
  tsFilesUnder,
} from "./skeleton-imports.ts";

const GUARD = "deliver";
// ADR 2026-062: TypeScript projects run on Bun. The shipped checker runs with
// bun, scripts are folded with `bun run`, and a missing package is added with
// `bun add --exact` (which also writes bun.lock). In a generated project none
// of these edits happen: deliver refuses instead (ADR 2026-054).
export const SURFACE_SCRIPT = "bun scripts/surface-check.ts";
/** The package manager and runner deliver spawns (no shell anywhere in this file). */
const BUN = "bun";
/** Generous: `bun run check` is a full typecheck plus the project's own suite. */
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const BARREL_MARKER = "// Public API of this package";

const README_SECTION = `## Contracts

Every \`src/**/*.contract.ts\` file declares the public surface of the module
beside it — the types, functions, and classes callers may depend on. The
sibling file of the same name implements it. In code review, the contract
file is the one to read first: it is the API.

\`npm run check\` fails if an implementation's exported surface drifts from
its contract. Changing a contract is therefore a deliberate design act:
edit the contract first, then bring the implementation along with it.
`;

/** One command invocation's outcome. `code` is null when the process never
 *  started or was killed (timeout) — a failure either way. */
export interface CommandOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command in `cwd` and returns its captured output. Never throws for a
 *  non-zero exit: deliver decides what a non-zero means. */
export type CommandRun = (command: string, args: readonly string[], cwd: string) => CommandOutcome;

/** The real runner: spawn the binary directly with an args ARRAY and no shell,
 *  so nothing in a target path is ever interpreted. */
export const spawnRun: CommandRun = (command, args, cwd) => {
  const r = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error !== undefined) return { code: null, stdout: r.stdout ?? "", stderr: r.error.message };
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export interface DeliverOptions {
  /** Path to the surface checker to ship. Default: this pack's
   *  surface-check.ts (or BOUNDED_DELIVER_SURFACE_CHECK). */
  readonly surfaceCheckSource?: string;
  /** How to run bun — the ts-morph install (step 5) and the project's own
   *  check (step 9). Default: {@link spawnRun}. Injectable so the wiring is
   *  unit-testable without a registry round trip or a real suite run. */
  readonly run?: CommandRun;
}

export interface DeliverResult {
  readonly code: number;
  readonly lines: readonly string[];
}

// --- pure cores -----------------------------------------------------------------

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Strip the compile-time conformance apparatus from an implementation file:
 * the `import type * as __Contract` line and the trailing
 * `const __conformance … ; void __conformance;` blob with its comment.
 * Returns the cleaned source, or null when there is nothing to strip.
 * Text surgery at AST positions: predictable, and it cannot touch anything
 * the AST did not point at.
 */
export function stripConformance(source: string, fileName: string): string | null {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sf = project.createSourceFile(basename(fileName), source, { overwrite: true });
  const ranges: [number, number][] = [];

  for (const stmt of sf.getStatements()) {
    if (Node.isImportDeclaration(stmt)) {
      const bindings = stmt.getImportClause()?.getNamedBindings();
      if (bindings && Node.isNamespaceImport(bindings) && bindings.getName() === "__Contract") {
        ranges.push([stmt.getStart(), stmt.getEnd()]);
      }
    } else if (Node.isVariableStatement(stmt)) {
      if (stmt.getDeclarations().some((d) => d.getName() === "__conformance")) {
        const comments = stmt.getLeadingCommentRanges();
        ranges.push([comments.length > 0 ? comments[0]!.getPos() : stmt.getStart(), stmt.getEnd()]);
      }
    } else if (Node.isExpressionStatement(stmt) && /^void\s+__conformance\s*;?$/.test(stmt.getText())) {
      ranges.push([stmt.getStart(), stmt.getEnd()]);
    }
  }
  if (ranges.length === 0) return null;

  let text = source;
  for (const [start, endRaw] of ranges.sort((a, b) => b[0] - a[0])) {
    let end = endRaw;
    if (text.startsWith("\r\n", end)) end += 2;
    else if (text.startsWith("\n", end)) end += 1;
    text = text.slice(0, start) + text.slice(end);
  }
  return text.replace(/\n+$/, "\n");
}

const ANSI = /\u001b\[[0-9;]*m/g;

function outputLines(out: CommandOutcome): string[] {
  return `${out.stdout}\n${out.stderr}`
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * The one line worth reprinting from a command that PASSED: the tally a reader
 * actually wants ("Tests  12 passed (12)"), not the whole transcript. Falls
 * back to the last line of output — a check script that says something else
 * still says it.
 */
export function checkSummaryLine(out: CommandOutcome): string | undefined {
  const lines = outputLines(out);
  for (const pattern of [/^Tests\s+\d/, /^Test Files\s+\d/, /^surface-check: OK\b/]) {
    const hit = lines.find((l) => pattern.test(l));
    if (hit !== undefined) return hit.slice(0, 200);
  }
  return lines.at(-1)?.slice(0, 200);
}

/** The last few output lines of a command that FAILED — enough to see why
 *  without replaying a whole suite into the reader's context. */
export function outputTail(out: CommandOutcome, max = 12): string[] {
  return outputLines(out)
    .slice(-max)
    .map((l) => l.slice(0, 200));
}

/** The barrel: one `export *` per implementation module (src-relative paths).
 *
 *  A `.tsx` module is spelled `.js` in the specifier exactly as a `.ts` one is
 *  — NodeNext specifiers name the EMITTED file, and TypeScript emits `badge.js`
 *  whichever of the two extensions the source carried. `badge.tsx` in a barrel
 *  would be a specifier no runtime can resolve. */
export function barrelFor(implRelToSrc: readonly string[]): string {
  const lines = [...implRelToSrc]
    .sort()
    .map((p) => `export * from "./${p.replace(/\.tsx?$/, ".js")}";`);
  return `${BARREL_MARKER} — one line per module. Generated at delivery.\n${lines.join("\n")}\n`;
}

// --- runner -----------------------------------------------------------------------

export function runDeliver(cwd: string, options: DeliverOptions = {}): DeliverResult {
  const lines: string[] = [];
  const run = options.run ?? spawnRun;
  let applied = 0;

  const log = (verdict: GuardVerdict, step: string, summary: string, detail: Record<string, unknown> = {}): void =>
    logGuardEvent(cwd, { guard: GUARD, verdict, summary, detail: { step, ...detail } });
  const pass = (step: string, changed: boolean, line: string, detail: Record<string, unknown> = {}): void => {
    if (changed) applied += 1;
    lines.push(`deliver: ${step} — ${line}`);
    log("pass", step, line, detail);
  };
  const block = (step: string, line: string, detail: Record<string, unknown> = {}): DeliverResult => {
    lines.push(`deliver: BLOCK — ${line}`);
    log("block", step, line, detail);
    return { code: 1, lines };
  };

  // --- preconditions (all checked before anything mutates) ---
  const misuse = (summary: string): DeliverResult => {
    log("error", "preflight", summary);
    return { code: 2, lines: [...lines, `deliver: error — ${summary}`] };
  };
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return misuse(`'${cwd}' is not a directory`);
  if (!existsSync(join(cwd, "package.json"))) return misuse(`no package.json in '${cwd}' — not a project root`);
  if (!existsSync(join(cwd, "src"))) return misuse(`no src/ in '${cwd}' — nothing to deliver`);
  const checkerSource =
    options.surfaceCheckSource ??
    process.env["BOUNDED_DELIVER_SURFACE_CHECK"] ??
    join(dirname(fileURLToPath(import.meta.url)), "surface-check.ts");
  if (!existsSync(checkerSource)) {
    return misuse(`surface checker source not found at '${checkerSource}'`);
  }

  // Delivery runs the project's own check over its config and must hand over
  // the config the composed packs generate (ADR 2026-054). Checked before
  // anything mutates; in a generated project the manifest steps below then
  // find everything already wired.
  const configBlock = configDriftBlock(GUARD, cwd);
  if (configBlock !== undefined) return { code: 1, lines: [...lines, ...configBlock.lines] };
  // In a generated project the manifest, lockfile and installed tree are the
  // packs' and the user's (ADR 2026-054): deliver changes none of them. A
  // step that would is refused instead — an unpinned dependency or unfolded
  // script is a pack defect, a missing install is the user's setup to run —
  // so delivery can never leave drift behind it.
  const configGenerated = configIsGenerated(cwd);
  const refuseConfigChange = (step: string, what: string, detail: Record<string, unknown> = {}): DeliverResult => {
    const result = block(
      step,
      `${what} — this project's config is generated from its composed packs, so deliver may not change ` +
        "the package manifest, the lockfile or the installed dependencies (ADR 2026-054)",
      { ...detail, route: "orchestrator" },
    );
    lines.push(`  a missing pin or script is a defect in the pack; missing installed dependencies are restored by the user with \`${SYNC_COMMAND}\``);
    lines.push("deliver: route → orchestrator");
    return { ...result, lines };
  };

  let registry;
  try {
    registry = composedPacks(cwd);
  } catch (error) {
    return block("composition", error instanceof Error ? error.message : String(error));
  }

  // --- 1. dead red-phase scaffolding ---
  const errorsAbs = join(cwd, ERRORS_REL);
  if (!existsSync(errorsAbs)) {
    pass("scaffolding", false, `${ERRORS_REL} already gone`);
  } else {
    // The src scan is the SHARED predicate green-gate now runs too — deliver is
    // the backstop, not the only line of defence (see skeleton-imports.ts). The
    // tests scan is deliver's own: a tests-only importer keeps errors.ts, it
    // does not block, so it is not part of the "unimplemented export" predicate.
    const srcImporters = findSkeletonImportsInSrc(cwd);
    const testImporters: string[] = [];
    for (const rel of tsFilesUnder(cwd, join(cwd, "tests"))) {
      if (errorsImportsOf(readFileSync(join(cwd, rel), "utf8"), rel).length > 0) testImporters.push(rel);
    }
    if (srcImporters.length > 0) {
      const [first] = srcImporters;
      return block(
        "scaffolding",
        `${first!.file} still imports ${first!.names.join(", ")} from the shared errors module — ` +
          `an unimplemented export survived to delivery`,
        { importers: srcImporters },
      );
    }
    if (testImporters.length > 0) {
      pass("scaffolding", false, `kept ${ERRORS_REL} (${testImporters.join(", ")} still imports it)`, {
        keptFor: testImporters,
      });
    } else {
      rmSync(errorsAbs);
      const sharedDir = dirname(errorsAbs);
      if (readdirSync(sharedDir).length === 0) rmdirSync(sharedDir);
      pass("scaffolding", true, `removed ${ERRORS_REL} (nothing imports it)`);
    }
  }

  // --- 2. the red-phase shadow project ---
  //
  // red_gate proves red in a project it builds itself at `.bounded/shadow-red/` —
  // contracts, regenerated skeletons and a copy of the tests tree — so the
  // proof never depends on the live `src/`, and the builder may work in
  // parallel without touching it. Once the run is over that copy is confusing
  // rather than useful: a duplicate of the tests beside the real one.
  //
  // Removal, not preservation: the shadow is reproducible from the repo at any
  // time by running red_gate again.
  {
    const shadowAbs = join(cwd, SHADOW_RELATIVE);
    if (existsSync(shadowAbs)) {
      rmSync(shadowAbs, { recursive: true, force: true });
      pass("shadow", true, `removed ${SHADOW_RELATIVE}/ (red_gate rebuilds it on demand)`);
    } else {
      pass("shadow", false, `no ${SHADOW_RELATIVE}/ to remove`);
    }
  }

  // --- pairs: contract → existing sibling implementation ---
  //
  // Both extensions (TN-26-006 A1): a component contract is implemented by a
  // `.tsx` sibling, and delivery must pair it exactly as it pairs a `.ts` one —
  // its __conformance blob still has to be stripped and it still belongs in the
  // barrel. Discovery is by EXISTENCE rather than by re-deciding the extension
  // from the contract, because by delivery the file on disk is the builder's
  // answer and the only one that matters; at most one sibling can be there, the
  // scaffolder having pruned the other.
  const srcAbs = join(cwd, "src");
  const pairs: string[] = []; // impl paths relative to src/, posix
  for (const contract of findContractFiles(srcAbs)) {
    for (const impl of skeletonSiblingPaths(contract)) {
      if (existsSync(impl)) pairs.push(toPosix(relative(srcAbs, impl)));
    }
  }

  // --- 3. __conformance blobs ---
  const stripped: string[] = [];
  for (const implRel of pairs) {
    const abs = join(srcAbs, implRel);
    const cleaned = stripConformance(readFileSync(abs, "utf8"), implRel);
    if (cleaned !== null) {
      writeFileSync(abs, cleaned);
      stripped.push("src/" + implRel);
    }
  }
  pass(
    "conformance",
    stripped.length > 0,
    stripped.length > 0 ? `stripped __conformance from ${stripped.join(", ")}` : "nothing to strip",
    { stripped },
  );

  // --- 4. barrel ---
  const indexAbs = join(srcAbs, "index.ts");
  if (pairs.length === 0) {
    pass("barrel", false, "no contract implementations — no barrel to write");
  } else {
    const desired = barrelFor(pairs);
    const existing = existsSync(indexAbs) ? readFileSync(indexAbs, "utf8") : undefined;
    if (existing === desired) {
      pass("barrel", false, "src/index.ts already current");
    } else if (existing !== undefined && !existing.startsWith(BARREL_MARKER)) {
      return block(
        "barrel",
        "src/index.ts already exists and was not generated by deliver — " +
          "merging its exports into the barrel is a design act; resolve it by hand",
      );
    } else {
      writeFileSync(indexAbs, desired);
      pass("barrel", true, `wrote src/index.ts (${pairs.length} module${pairs.length === 1 ? "" : "s"})`, {
        modules: pairs,
      });
    }
  }

  // --- 5. ship the surface check ---
  {
    const checker = readFileSync(checkerSource, "utf8");
    const shippedAbs = join(cwd, "scripts", "surface-check.ts");
    const did: string[] = [];
    const ship = !existsSync(shippedAbs) || readFileSync(shippedAbs, "utf8") !== checker;
    if (ship) did.push("shipped scripts/surface-check.ts");
    const pkgAbs = join(cwd, "package.json");
    const pkg = JSON.parse(readFileSync(pkgAbs, "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    pkg.scripts ??= {};
    if (pkg.scripts["check:surface"] !== SURFACE_SCRIPT) {
      pkg.scripts["check:surface"] = SURFACE_SCRIPT;
      did.push("added check:surface");
    }
    if (pkg.scripts["check"] === undefined) {
      pkg.scripts["check"] = "bun run check:surface";
      did.push("created check");
    } else if (!pkg.scripts["check"].includes("check:surface")) {
      pkg.scripts["check"] += " && bun run check:surface";
      did.push("folded into check");
    }
    const pin = pkg.devDependencies?.["ts-morph"] ?? tsMorphPin();
    if (pkg.devDependencies?.["ts-morph"] === undefined) {
      const deps: Record<string, string> = { ...pkg.devDependencies, "ts-morph": pin };
      pkg.devDependencies = Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]!]));
      did.push(`pinned ts-morph@${pin}`);
    }
    if (configGenerated && did.length > 0) {
      return refuseConfigChange("surface-check", `the generated project lacks what the surface check needs (${did.join(", ")})`, { did });
    }
    if (ship) {
      mkdirSync(dirname(shippedAbs), { recursive: true });
      writeFileSync(shippedAbs, checker);
    }
    if (did.some((what) => what !== "shipped scripts/surface-check.ts")) writeFileSync(pkgAbs, JSON.stringify(pkg, null, 2) + "\n");

    // The pin must be MATERIALIZED, not merely written. r15 shipped two repos
    // whose `npm run check` died on ERR_MODULE_NOT_FOUND: deliver added the
    // devDependency and nothing ever installed it. Deliver ships no dependency
    // it cannot resolve afterwards — a failed install is a BLOCK, not a repo
    // handed over with a broken check.
    //
    // REJECTED ALTERNATIVE: vendor a ts-morph-free checker into the target
    // (TypeScript's own compiler API, or text extraction) so delivery adds no
    // dependency at all — which would also settle the AGENTS.md "do not add
    // dependencies" tension outright. Rejected because it forks the checker in
    // two: the harness would gate runs with the ts-morph version while targets
    // shipped an untested twin, and the two would drift apart at the first
    // rule change. ONE checker, copied verbatim (see surface-check.ts's
    // DUAL-USE header), is the property worth paying an install for.
    // CHOSEN: install the pinned version, then verify it resolves.
    const tsMorphAbs = join(cwd, "node_modules", "ts-morph", "package.json");
    if (!existsSync(tsMorphAbs) && configGenerated) {
      return refuseConfigChange("surface-check", `ts-morph@${pin} is pinned but not installed`, { pin });
    }
    if (!existsSync(tsMorphAbs)) {
      const args = ["add", "--dev", "--exact", "--ignore-scripts", `ts-morph@${pin}`];
      const out = run(BUN, args, cwd);
      const fail = (why: string): DeliverResult => {
        const tail = outputTail(out);
        const result = block(
          "surface-check",
          `could not install ts-morph@${pin} into the target — ${why}; the shipped ` +
            `check:surface script would die with ERR_MODULE_NOT_FOUND, so this repo is not delivered ` +
            `(re-run deliver where the package registry is reachable)`,
          { pin, exitCode: out.code, tail },
        );
        lines.push(...tail.map((t) => `  install: ${t}`));
        return { ...result, lines };
      };
      if (out.code !== 0) return fail(`\`bun add\` ${out.code === null ? "never completed" : `exited ${out.code}`}`);
      if (!existsSync(tsMorphAbs)) return fail("bun reported success but node_modules/ts-morph is still missing");
      did.push(`installed ts-morph@${pin}`);
    }
    pass("surface-check", did.length > 0, did.length > 0 ? did.join(", ") : "already shipped and wired", { did });
  }

  // --- 5b. blessed stack pins (ADR 2026-029, TN-26-004) ---
  //
  // The stack is harness policy, and a policy nobody installed is a repo
  // whose check dies with ERR_MODULE_NOT_FOUND — the ts-morph lesson (r15),
  // applied to the blessed stacks. What the tree USES decides what is
  // pinned: zod when any src module imports it (every zod-backed value
  // object does), and whatever a composed pack's shipped support file imports
  // when the tree carries that file (ADR 2026-046) — the pack names its own
  // packages; this step names none. Regular dependencies, not dev — all are
  // imported by shipped src/**.
  // The pin is the pack's own version, and a failed install is a BLOCK.
  {
    const srcFiles = tsFilesUnder(cwd, srcAbs);
    const importsZod = srcFiles.some((rel) =>
      /from\s+["']zod(\/[^"']*)?["']/.test(readFileSync(join(cwd, rel), "utf8")),
    );
    const firstLines = srcFiles.map((rel) => readFileSync(join(cwd, rel), "utf8").split("\n", 1)[0] ?? "");
    const supportDeps = registry
      .read(contractSupportFiles)
      .filter((file) => firstLines.some((line) => line.startsWith(`// GENERATED from ${file.canonical} `)))
      .flatMap((file) => file.dependencies ?? []);
    const wanted: readonly string[] = [...new Set([...(importsZod ? ["zod"] : []), ...supportDeps])];
    const did: string[] = [];
    for (const name of wanted) {
      const pkgAbs = join(cwd, "package.json");
      const pkg = JSON.parse(readFileSync(pkgAbs, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const pin = pkg.dependencies?.[name] ?? packPin(name);
      if (pkg.dependencies?.[name] === undefined && configGenerated) {
        return refuseConfigChange("stack-pins", `the tree imports ${name}, which no composed pack pins`, { name });
      }
      if (pkg.dependencies?.[name] === undefined) {
        const deps: Record<string, string> = { ...pkg.dependencies, [name]: pin };
        pkg.dependencies = Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]!]));
        writeFileSync(pkgAbs, JSON.stringify(pkg, null, 2) + "\n");
        did.push(`pinned ${name}@${pin}`);
      }
      const installedAbs = join(cwd, "node_modules", ...name.split("/"), "package.json");
      if (!existsSync(installedAbs) && configGenerated) {
        return refuseConfigChange("stack-pins", `${name}@${pin} is pinned but not installed`, { name, pin });
      }
      if (!existsSync(installedAbs)) {
        const out = run(
          BUN,
          ["add", "--exact", "--ignore-scripts", `${name}@${pin}`],
          cwd,
        );
        if (out.code !== 0 || !existsSync(installedAbs)) {
          const tail = outputTail(out);
          const result = block(
            "stack-pins",
            `could not install ${name}@${pin} into the target — the tree imports it, so shipping ` +
              `without it is a repo whose check dies with ERR_MODULE_NOT_FOUND; re-run deliver where ` +
              `the package registry is reachable`,
            { name, pin, exitCode: out.code, tail },
          );
          lines.push(...tail.map((t) => `  install: ${t}`));
          return { ...result, lines };
        }
        did.push(`installed ${name}@${pin}`);
      }
    }
    pass(
      "stack-pins",
      did.length > 0,
      did.length > 0 ? did.join(", ") : wanted.length > 0 ? "already pinned and installed" : "no blessed stacks in use",
      { wanted, did },
    );
  }

  // --- 5c. pack-contributed check scripts folded into `check` (ADR 2026-033) ---
  //
  // A composed pack's acceptance can also belong in the project's OWN
  // definition of done. Deliver folds `check:surface` into `check` at step 5;
  // a pack contributes the same shape through the deliverChecks socket's
  // optional `checkScript`, and deliver folds it here the same way — reading a
  // `{ name, command }` and learning no framework name (TN-26-005), exactly as
  // step 5 folds surface-check without knowing what ts-morph is.
  //
  // Dogfood Run 29 is why: a composed web app whose `npm run check` passed
  // while its build failed, because check's scope never reached the web
  // bootstrap. Keyed on the tree by the pack — a service gets no build folded
  // in — and placed before step 9 so the project's own check (which step 9
  // runs) actually exercises what was folded.
  {
    const scripts = registry
      .read(deliverChecks)
      .map((check) => check.checkScript?.(cwd))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    const did: string[] = [];
    if (scripts.length > 0) {
      const pkgAbs = join(cwd, "package.json");
      const pkg = JSON.parse(readFileSync(pkgAbs, "utf8")) as { scripts?: Record<string, string> };
      pkg.scripts ??= {};
      for (const { name, command } of scripts) {
        if (pkg.scripts[name] !== command) {
          pkg.scripts[name] = command;
          did.push(`set ${name}`);
        }
        if (pkg.scripts["check"] === undefined) {
          pkg.scripts["check"] = `bun run ${name}`;
          did.push(`created check with ${name}`);
        } else if (!pkg.scripts["check"].includes(`run ${name}`)) {
          pkg.scripts["check"] += ` && bun run ${name}`;
          did.push(`folded ${name} into check`);
        }
      }
      if (configGenerated && did.length > 0) {
        return refuseConfigChange("check-scripts", `the generated manifest does not fold every pack check script (${did.join(", ")})`, { did });
      }
      if (did.length > 0) writeFileSync(pkgAbs, JSON.stringify(pkg, null, 2) + "\n");
    }
    pass(
      "check-scripts",
      did.length > 0,
      did.length > 0 ? did.join(", ") : "no composed pack folds a check script into this tree",
      { did },
    );
  }

  // --- 6. .gitignore ---
  {
    const ignoreAbs = join(cwd, ".gitignore");
    const current = existsSync(ignoreAbs) ? readFileSync(ignoreAbs, "utf8") : "";
    // A project-local installation commits selected files beneath .bounded/.
    // Its `.bounded/*` rule ignores runtime state while later negations keep
    // the installed harness and composition visible to Git. Appending a broad
    // `.bounded/` rule would hide those files before the first commit.
    const ignored = current.split("\n").some((l) =>
      l.trim() === ".bounded/" || l.trim() === ".bounded" || l.trim() === ".bounded/*");
    if (ignored) {
      pass("gitignore", false, ".bounded/ already ignored");
    } else {
      writeFileSync(ignoreAbs, (current === "" || current.endsWith("\n") ? current : current + "\n") + ".bounded/\n");
      pass("gitignore", true, "added .bounded/ to .gitignore");
    }
  }

  // --- 7. README ---
  {
    const readmeAbs = join(cwd, "README.md");
    const current = existsSync(readmeAbs) ? readFileSync(readmeAbs, "utf8") : undefined;
    if (current?.includes("## Contracts")) {
      pass("readme", false, "README.md already documents contracts");
    } else if (current !== undefined) {
      writeFileSync(readmeAbs, (current.endsWith("\n") ? current : current + "\n") + "\n" + README_SECTION);
      pass("readme", true, 'appended "## Contracts" to README.md');
    } else {
      writeFileSync(readmeAbs, README_SECTION);
      pass("readme", true, 'created README.md with a "## Contracts" section');
    }
  }

  // --- 8. phase timing (issue #13) ---
  //
  // Every gate already timestamps itself into .bounded/guard-log.jsonl, so the
  // shape of the run — which phase cost the minutes, where it bounced and to
  // whom — is recorded and was simply never read back. Delivery is the one
  // moment the whole run is over and someone is reading the output, so this
  // is where the read-back belongs.
  //
  // Idempotency: trivial, unlike every step above. This one READS and writes
  // nothing, so it is never an applied step and a second delivery re-reports
  // the same run (plus the events the first delivery itself logged).
  //
  // It must never block delivery. An absent, empty or corrupt log is a missing
  // measurement, not a defect in the repo being handed over: the step degrades
  // to one line saying timing was unavailable and why, and delivery proceeds.
  {
    let timing: PhaseDurations | undefined;
    let blockLines: string[];
    try {
      timing = phaseDurations(readGuardLog(cwd));
      blockLines = formatPhaseDurations(timing);
    } catch (e) {
      blockLines = [`unavailable — ${e instanceof Error ? e.message : String(e)}`];
    }
    const [headline, ...rest] = blockLines;
    pass(
      "timing",
      false,
      headline ?? "unavailable — nothing to report",
      timing !== undefined ? { timing } : {},
    );
    lines.push(...rest);
  }

  // --- 9. the project's own check (issue: r15 shipped two red repos) ---
  //
  // Every step above is deliver's opinion of a finished repo. This one asks the
  // REPO: `npm run check` is the project's own declared definition of done
  // (AGENTS.md, ADR 2026-007), and until now nothing in the pipeline ever ran
  // it — green_gate runs its own tsc and vitest, which is not the same command
  // a colleague types, and is blind to whatever delivery itself just wired in.
  //
  // ORDERING. Last, for two reasons. It must judge the tree that actually
  // ships, so it runs after every mutating step (the barrel, the stripped
  // conformance blobs, the freshly wired check:surface and its install). And
  // it runs after the read-only timing step so that a RED check still leaves
  // the run's timing report on screen: the block is the headline, but the
  // minutes are the thing nobody can reconstruct later.
  //
  // Read-only, so it is never an applied step — a second delivery re-runs it
  // and still reports 0 steps applied.
  {
    const out = run(BUN, ["run", "check"], cwd);
    if (out.code !== 0) {
      const tail = outputTail(out);
      const result = block(
        "check",
        `the project's own \`bun run check\` is RED ` +
          `(${out.code === null ? "it never completed" : `bun exited ${out.code}`}) — the repo does not ` +
          `satisfy its own definition of done, so it is not ready to hand over; fix it and re-run deliver`,
        { exitCode: out.code, tail },
      );
      lines.push(...tail.map((t) => `  check: ${t}`));
      return { ...result, lines };
    }
    const summaryLine = checkSummaryLine(out);
    pass(
      "check",
      false,
      summaryLine === undefined ? "bun run check passed" : `bun run check passed — ${summaryLine}`,
      { exitCode: 0, summary: summaryLine },
    );
  }

  // --- 10. pack-contributed checks (ADR 2026-033) ---
  //
  // The socket exists because the alternative is worse in both directions:
  // hard-wiring "theme" — and eventually "colour", "route", "component" — into
  // this file for a pack it must not know about, or leaving the claim
  // unchecked. Read here, exactly as `lint-src` reads its rules: a harness
  // composed without the contributing pack runs zero of them and delivers as it
  // always did.
  //
  // LAST, because a check must judge the tree that actually ships — after the
  // barrel, the stripped blobs, the wiring this pass added, and after the repo
  // has satisfied its own definition of done. The consequence is accepted: a
  // red `npm run check` returns above, so these verdicts appear once the repo
  // is green.
  {
    const checks = registry.read(deliverChecks);
    for (const check of checks) {
      let outcome: DeliverCheckResult;
      try {
        outcome = check.run(cwd, registry.packs);
      } catch (e) {
        // A check that crashed verified nothing, and "nothing verified" is not
        // a pass. The pack's name is in the step, so the fix has an owner.
        outcome = {
          verdict: "block",
          summary: `the check threw — ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const detail = outcome.detail ?? [];
      if (outcome.verdict === "block") {
        const result = block(check.name, `${check.name}: ${outcome.summary}`, {
          check: check.name,
          problems: detail,
        });
        lines.push(...detail.map((d) => `  ${check.name}: ${d}`));
        return { ...result, lines };
      }
      pass(check.name, false, outcome.summary, { check: check.name });
      lines.push(...detail.map((d) => `  ${check.name}: ${d}`));
    }
    if (checks.length === 0) pass("pack-checks", false, "no composed pack contributes one");
  }

  // Nothing above may have changed project config, and the project's own
  // check may have written something: prove it before calling this delivered.
  const finalBlock = configDriftBlock(GUARD, cwd);
  if (finalBlock !== undefined) return { code: 1, lines: [...lines, ...finalBlock.lines] };

  const summary = `deliver: OK — ${applied} steps applied`;
  lines.push(summary);
  log("pass", "summary", summary, { applied });
  return { code: 0, lines };
}

/** The pack's own pinned version of a blessed dependency — targets get the
 *  same pin, so the harness and every delivered repo run one version. */
function packPin(name: string): string {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  const pin = pkg.devDependencies?.[name];
  if (pin === undefined) throw new Error(`deliver: cannot find the pack's ${name} version to pin`);
  return pin;
}

/** The pack's own ts-morph version — the shipped checker gets the same pin. */
function tsMorphPin(): string {
  return packPin("ts-morph");
}

// --- CLI ------------------------------------------------------------------------

// Symlink-safe main check (invoked via the ~/.pi/agent symlink): compare realpaths.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const { code, lines } = runDeliver(process.argv[2] ?? process.cwd());
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  process.exit(code);
}
