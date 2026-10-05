// Delivery pass (TN-26-001): finished run → repo you would hand a colleague.
//
//   bounded gates deliver [targetDir]
//
// The developer stage leaves the target correct but harness-shaped: the
// red-phase errors modules, the red gate's shadow project, and nothing that
// keeps contract/implementation alignment honest once the harness is gone.
// This pass is mechanical — it decides nothing about the design; it only
// removes what the loop needed and checks what a colleague needs. Steps, in
// order, each logging one guard event and printing one line:
//
//   1. scaffolding    delete every red-phase generated module (the emitters'
//                     output at phase `red` that they no longer produce at
//                     `deliver`: each context's `domain/shared/errors.ts`,
//                     TN-26-012 §5) iff nothing imports it (ts-morph, not
//                     grep). A surviving import is a BLOCK: from source, an
//                     unimplemented skeleton reached delivery (route →
//                     builder); from a test, the suite depends on red-phase
//                     scaffolding (route → test-writer).
//   2. shadow         remove .bounded/shadow-red/, the throwaway project red_gate
//                     rebuilds to prove red in.
//   3. generated      every generated file the emitters produce at `deliver`
//                     is on disk byte for byte (ADR 2026-058), and no skeleton
//                     file still throws NotImplementedError. Out of date →
//                     BLOCK, route → orchestrator (re-run the design gate);
//                     a throwing skeleton → BLOCK, route → builder.
//   4. surface check  the shipped scripts/surface-check.ts is present and
//                     wired into `check`; in a project whose config the packs
//                     generate (ADR 2026-054) the manifest must already carry
//                     it, and anything missing is a BLOCK. In a project whose
//                     config they do not generate, deliver ships and pins it,
//                     with bun (ADR 2026-062).
//   5. gitignore      ensure `.bounded/` is ignored.
//   6. README         add a "## Contracts" section for a reader who has
//                     never seen the convention.
//   7. timing         READ-ONLY: where the run's minutes went, from the guard log.
//   8. check          READ-ONLY: the green test obligations first (an app's
//                     smoke test and its own database, issue #52), then the
//                     project's OWN `bun run check`, BLOCK if red. Every other
//                     step is deliver's opinion of a finished repo; this one
//                     asks the repo whether it satisfies its own definition of
//                     done.
//   9. pack checks    READ-ONLY, and LAST: every `deliverChecks` contribution
//                     (ADR 2026-033), in composition order.
//
// Idempotent: every step checks before acting; a second run applies 0 steps.
// Exit 0 delivered · 1 block · 2 misuse (bad target / missing checker
// source). The checker source is injectable for tests via options or
// BOUNDED_DELIVER_SURFACE_CHECK; so is the command runner (DeliverOptions.run).

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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logGuardEvent, readGuardLog, type GuardVerdict } from "../../../src/guard-log.ts";
import { generatedFileGlobs, hasTestFileSuffix, sourceRoots, testFileSuffixes } from "../../../src/pack-contrib.ts";
import {
  formatPhaseDurations,
  phaseDurations,
  type PhaseDurations,
} from "../../../src/phase-durations.ts";
import { composedPacks } from "../../installed.ts";
import { deliverChecks, type DeliverCheckResult } from "../pack.ts";
import { configDriftBlock, configIsGenerated, TEAM_LEAD_RESTORES } from "./project-config.ts";
import { greenObligations } from "./green-gate.ts";
import { emitProject, projectFactsOf, type ProjectFile } from "./project-emitters.ts";
import { phaseRun, type PhaseRun, withPreparedServices } from "./phase-policy.ts";
import { SHADOW_RELATIVE } from "./red-gate.ts";
import { errorsImportsOf, tsFilesUnder } from "./skeleton-imports.ts";
import { expandSourceRoots } from "./surface-check.ts";

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

const README_SECTION = `## Contracts

Every \`*.contract.ts\` file under a workspace's \`src/\` declares a public
surface: a domain concept's interface and factory, or a feature's input,
command, in port and out ports. The file beside it implements it: the
concept's \`<concept>.ts\`, the feature's \`<feature>.handler.ts\`. In code
review, the contract is the file to read first: it is the API.

\`bun run check\` fails if an implementation's exported surface drifts from
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
export type CommandRun = (command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => CommandOutcome;

/** The real runner: spawn the binary directly with an args ARRAY and no shell,
 *  so nothing in a target path is ever interpreted. */
export const spawnRun: CommandRun = (command, args, cwd, env) => {
  const r = spawnSync(command, [...args], {
    cwd,
    env: env ?? process.env,
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
  /** The phase test policies the project's own check runs under. Default:
   *  the project's green policies, so it is refused where green would be. */
  readonly policy?: Pick<PhaseRun, "refusals" | "env" | "prepares"> & Partial<Pick<PhaseRun, "refusalRoute">>;
}

export interface DeliverResult {
  readonly code: number;
  readonly lines: readonly string[];
}

// --- pure cores -----------------------------------------------------------------


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

// --- runner -----------------------------------------------------------------------

/** Every TypeScript file under the composed source roots, project-relative. */
function sourceFiles(cwd: string, roots: readonly string[]): string[] {
  return expandSourceRoots(cwd, roots).flatMap((dir) => tsFilesUnder(cwd, join(cwd, dir))).sort();
}

/** Remove the directories `rel` leaves empty, up to (not including) the root. */
function removeEmptyParents(cwd: string, rel: string): void {
  let dir = dirname(rel);
  while (dir !== "." && dir !== "") {
    const abs = join(cwd, dir);
    if (!existsSync(abs) || readdirSync(abs).length > 0) return;
    rmdirSync(abs);
    dir = dirname(dir);
  }
}

/** A skeleton file that still throws: it constructs the red-phase error. */
const THROWS_NOT_IMPLEMENTED = /\bnew\s+NotImplementedError\s*\(/;

export async function runDeliver(cwd: string, options: DeliverOptions = {}): Promise<DeliverResult> {
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
  const block = (step: string, line: string, detail: Record<string, unknown> = {}, route?: string): DeliverResult => {
    lines.push(`deliver: BLOCK — ${line}`);
    if (route !== undefined) lines.push(`deliver: route → ${route}`);
    log("block", step, line, route !== undefined ? { ...detail, route } : detail);
    return { code: 1, lines };
  };

  // --- preconditions (all checked before anything mutates) ---
  const misuse = (summary: string): DeliverResult => {
    log("error", "preflight", summary);
    return { code: 2, lines: [...lines, `deliver: error — ${summary}`] };
  };
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return misuse(`'${cwd}' is not a directory`);
  if (!existsSync(join(cwd, "package.json"))) return misuse(`no package.json in '${cwd}' — not a project root`);
  let roots: readonly string[];
  let suffixes: readonly string[];
  try {
    roots = sourceRoots(cwd);
    suffixes = testFileSuffixes(cwd);
  } catch (error) {
    return misuse(error instanceof Error ? error.message : String(error));
  }
  if (roots.length === 0) return misuse("no composed pack declares source roots — nothing to deliver");
  const checkerSource =
    options.surfaceCheckSource ??
    process.env["BOUNDED_DELIVER_SURFACE_CHECK"] ??
    join(dirname(fileURLToPath(import.meta.url)), "surface-check.ts");
  if (!existsSync(checkerSource)) {
    return misuse(`surface checker source not found at '${checkerSource}'`);
  }

  // Delivery runs the project's own check over its config and must hand over
  // the config the composed packs generate (ADR 2026-054). Checked before
  // anything mutates.
  const configBlock = configDriftBlock(GUARD, cwd);
  if (configBlock !== undefined) return { code: 1, lines: [...lines, ...configBlock.lines] };
  const configGenerated = configIsGenerated(cwd);
  const refuseConfigChange = (step: string, what: string, detail: Record<string, unknown> = {}): DeliverResult => {
    lines.push(`deliver: BLOCK — ${what} — this project's config is generated from its composed packs, so deliver may not change ` +
      "the package manifest, the lockfile or the installed dependencies (ADR 2026-054)");
    lines.push(`  a missing pin or script is a defect in the pack; for missing installed dependencies, ${TEAM_LEAD_RESTORES}`);
    lines.push("deliver: route → orchestrator");
    log("block", step, what, { ...detail, route: "orchestrator" });
    return { code: 1, lines };
  };

  let registry;
  let atRed: ProjectFile[];
  let atDelivery: ProjectFile[];
  try {
    registry = composedPacks(cwd);
    const globs = generatedFileGlobs(cwd);
    atRed = emitProject(projectFactsOf(cwd, "red"), globs);
    atDelivery = emitProject(projectFactsOf(cwd, "deliver"), globs);
  } catch (error) {
    return block("composition", `the design cannot be emitted: ${error instanceof Error ? error.message : String(error)}`, {}, "orchestrator");
  }

  // --- 3 (checked first, before anything mutates). generated files in sync, no skeleton left throwing ---
  {
    const stale = atDelivery
      .filter((f) => f.mode === "generated")
      .filter((f) => !existsSync(join(cwd, f.path)) || readFileSync(join(cwd, f.path), "utf8") !== f.content)
      .map((f) => f.path);
    if (stale.length > 0) {
      return block(
        "generated",
        `${stale.length} generated file${stale.length === 1 ? " is" : "s are"} not what the design produces (${stale.join(", ")}); ` +
          "no role writes them — run the design gate, whose scaffold step rewrites them, and prove red and green again",
        { stale },
        "orchestrator",
      );
    }
    const throwing = atDelivery
      .filter((f) => f.mode === "skeleton" && existsSync(join(cwd, f.path)))
      .filter((f) => THROWS_NOT_IMPLEMENTED.test(readFileSync(join(cwd, f.path), "utf8")))
      .map((f) => f.path);
    if (throwing.length > 0) {
      return block(
        "generated",
        `${throwing.join(", ")} still throw${throwing.length === 1 ? "s" : ""} NotImplementedError — a skeleton the builder never finished`,
        { throwing },
        "builder",
      );
    }
    const generated = atDelivery.filter((f) => f.mode === "generated").length;
    pass("generated", false, `${generated} generated file${generated === 1 ? "" : "s"} in sync; no skeleton left unimplemented`);
  }

  // --- 1. red-phase scaffolding ---
  //
  // What the emitters produce at `red` and no longer at `deliver` is
  // red-phase only: the errors module skeletons import NotImplementedError
  // from (TN-26-012 §5).
  {
    const delivered = new Set(atDelivery.map((f) => f.path));
    const redOnly = atRed.filter((f) => f.mode === "generated" && !delivered.has(f.path)).map((f) => f.path);
    const present = redOnly.filter((rel) => existsSync(join(cwd, rel)));
    const importers: { file: string; names: readonly string[]; test: boolean }[] = [];
    for (const rel of sourceFiles(cwd, roots)) {
      if (present.includes(rel)) continue;
      const names = errorsImportsOf(readFileSync(join(cwd, rel), "utf8"), rel, present);
      if (names.length > 0) importers.push({ file: rel, names, test: hasTestFileSuffix(rel, suffixes) });
    }
    const source = importers.filter((i) => !i.test);
    const tests = importers.filter((i) => i.test);
    if (source.length > 0) {
      return block(
        "scaffolding",
        `${source.map((i) => i.file).join(", ")} still import${source.length === 1 ? "s" : ""} ${source[0]!.names.join(", ")} from the red-phase errors module — an unimplemented skeleton survived to delivery`,
        { importers: source },
        "builder",
      );
    }
    if (tests.length > 0) {
      return block(
        "scaffolding",
        `${tests.map((i) => i.file).join(", ")} import${tests.length === 1 ? "s" : ""} the red-phase errors module, which delivery removes — a test may not depend on red-phase scaffolding`,
        { importers: tests },
        "test-writer",
      );
    }
    for (const rel of present) {
      rmSync(join(cwd, rel));
      removeEmptyParents(cwd, rel);
    }
    pass(
      "scaffolding",
      present.length > 0,
      present.length > 0 ? `removed ${present.join(", ")} (nothing imports ${present.length === 1 ? "it" : "them"})` : "no red-phase module left",
      { removed: present },
    );
  }

  // --- 2. the red-phase shadow project ---
  {
    const shadowAbs = join(cwd, SHADOW_RELATIVE);
    if (existsSync(shadowAbs)) {
      rmSync(shadowAbs, { recursive: true, force: true });
      pass("shadow", true, `removed ${SHADOW_RELATIVE}/ (red_gate rebuilds it on demand)`);
    } else {
      pass("shadow", false, `no ${SHADOW_RELATIVE}/ to remove`);
    }
  }

  // --- 4. the surface check ---
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

    // A pin nobody installed is a repo whose check dies with
    // ERR_MODULE_NOT_FOUND (r15): install it, then verify it resolves.
    const tsMorphAbs = join(cwd, "node_modules", "ts-morph", "package.json");
    if (!existsSync(tsMorphAbs) && configGenerated) {
      return refuseConfigChange("surface-check", `ts-morph@${pin} is pinned but not installed`, { pin });
    }
    if (!existsSync(tsMorphAbs)) {
      const out = run(BUN, ["add", "--dev", "--exact", "--ignore-scripts", `ts-morph@${pin}`], cwd);
      if (out.code !== 0 || !existsSync(tsMorphAbs)) {
        const tail = outputTail(out);
        const result = block(
          "surface-check",
          `could not install ts-morph@${pin} into the target — the shipped check:surface script would die with ` +
            "ERR_MODULE_NOT_FOUND, so this repo is not delivered (re-run deliver where the package registry is reachable)",
          { pin, exitCode: out.code, tail },
        );
        lines.push(...tail.map((t) => `  install: ${t}`));
        return { ...result, lines };
      }
      did.push(`installed ts-morph@${pin}`);
    }
    pass("surface-check", did.length > 0, did.length > 0 ? did.join(", ") : "already shipped and wired", { did });
  }

  // --- 4b. pack-contributed check scripts folded into `check` (ADR 2026-033) ---
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
    pass("check-scripts", did.length > 0, did.length > 0 ? did.join(", ") : "no composed pack folds a check script into this tree", { did });
  }

  // --- 5. .gitignore ---
  {
    const ignoreAbs = join(cwd, ".gitignore");
    const current = existsSync(ignoreAbs) ? readFileSync(ignoreAbs, "utf8") : "";
    // A project-local installation commits selected files beneath .bounded/:
    // its `.bounded/*` rule ignores runtime state while later negations keep
    // the installed harness visible. A broad `.bounded/` rule would hide them.
    const ignored = current.split("\n").some((l) =>
      l.trim() === ".bounded/" || l.trim() === ".bounded" || l.trim() === ".bounded/*");
    if (ignored) {
      pass("gitignore", false, ".bounded/ already ignored");
    } else {
      writeFileSync(ignoreAbs, (current === "" || current.endsWith("\n") ? current : current + "\n") + ".bounded/\n");
      pass("gitignore", true, "added .bounded/ to .gitignore");
    }
  }

  // --- 6. README ---
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

  // --- 7. phase timing (issue #13): read-only, never blocks ---
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
    pass("timing", false, headline ?? "unavailable — nothing to report", timing !== undefined ? { timing } : {});
    lines.push(...rest);
  }

  // --- 8. the project's own check (r15 shipped two red repos) ---
  {
    // The green-only obligations first, as green checks them: a smoke test
    // that would reach for a database it did not start never runs (issue
    // #52). They are static, so the suite does not run to find them.
    const obligations = greenObligations(cwd, GUARD);
    if (obligations !== undefined) {
      lines.push(...obligations.lines);
      log("block", "check", obligations.summary, obligations.detail);
      return { code: 1, lines };
    }
    // The check runs the whole suite, app smoke tests and store tests
    // included: under the green policies, exactly as green ran it, so it is
    // refused where green would be. Each app's smoke tests start their own
    // database through the generated support, which overrides any inherited
    // or .env DATABASE_URL (ADR 2026-072).
    const policy = options.policy ?? phaseRun(cwd, "green");
    if (policy.refusals.length > 0) {
      const result = block("check", `the project's own \`bun run check\` cannot run here: ${policy.refusals.join("; ")}`, { reason: "test-policy" },
        policy.refusalRoute ?? "orchestrator");
      return { ...result, lines };
    }
    const prepared = await withPreparedServices(policy, async (env) => {
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const name of env.unset) delete childEnv[name];
      Object.assign(childEnv, env.set);
      return run(BUN, ["run", "check"], cwd, childEnv);
    });
    if (!prepared.ok) {
      const result = block("check", `the project's own \`bun run check\` cannot run here: ${prepared.reason}`, { reason: "test-policy" },
        prepared.route ?? "orchestrator");
      return { ...result, lines };
    }
    for (const line of prepared.lines) lines.push(`deliver: check — ${line}`);
    const out = prepared.value;
    if (out.code !== 0) {
      const tail = outputTail(out);
      const result = block(
        "check",
        `the project's own \`bun run check\` is RED ` +
          `(${out.code === null ? "it never completed" : `bun exited ${out.code}`}) — the repo does not ` +
          "satisfy its own definition of done, so it is not ready to hand over; fix it and re-run deliver",
        { exitCode: out.code, tail },
      );
      lines.push(...tail.map((t) => `  check: ${t}`));
      return { ...result, lines };
    }
    const summaryLine = checkSummaryLine(out);
    pass("check", false, summaryLine === undefined ? "bun run check passed" : `bun run check passed — ${summaryLine}`, {
      exitCode: 0,
      summary: summaryLine,
    });
  }

  // --- 9. pack-contributed checks (ADR 2026-033) ---
  {
    const checks = registry.read(deliverChecks);
    for (const check of checks) {
      let outcome: DeliverCheckResult;
      try {
        outcome = check.run(cwd, registry.packs);
      } catch (e) {
        outcome = { verdict: "block", summary: `the check threw — ${e instanceof Error ? e.message : String(e)}` };
      }
      const detail = outcome.detail ?? [];
      if (outcome.verdict === "block") {
        const result = block(check.name, `${check.name}: ${outcome.summary}`, { check: check.name, problems: detail });
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
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  // Runtime dependencies first: the harness ships what its own code imports.
  const pin = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
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
  const { code, lines } = await runDeliver(process.argv[2] ?? process.cwd());
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  process.exit(code);
}
