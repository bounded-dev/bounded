// The TypeScript pack's gate registry (ADR 2026-034).
//
// Every artifact gate this pack contributes, as one list the root discovers by
// convention (`packs/*/gates.ts`) and never by name. `bounded gates` reads it for
// its command line; the pi extensions read it for their tool roster; a second
// host reads it for whatever it binds. A gate's name, tool name, description,
// flags and prompt guidance therefore live HERE and nowhere else — the
// descriptions were lifted verbatim from the extensions that used to hold
// them, and the drift tests still pin their phrases.
//
// Each `run` is the same function the pack's own script calls from its `main`,
// so a gate cannot differ by how it was invoked. Runners that still answer in
// the bare `{code, lines}` shape are lifted onto the contract by
// `toGateResult`; their own return types are left alone.
//
// The runners are imported inside `run`, not at the top: the table itself is
// what `bounded gates --list`, a usage message and a tool roster need, and loading
// every gate's machinery (eslint, ts-morph, …) to print a table cost a second
// per invocation. A gate's cost is paid when it runs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  argJson,
  argNumber,
  argString,
  argStrings,
  type FlagSpec,
  type GateArgs,
  type GateCommand,
} from "../../src/gate-command.ts";
import { gateError, guardVerdictOf, toGateResult, type GateResult } from "../../src/gate-result.ts";
import { logGuardEvent } from "../../src/guard-log.ts";

// --- shared pieces ----------------------------------------------------------------

const PATTERN_FLAG: FlagSpec = {
  name: "pattern",
  kind: "string",
  repeatable: true,
  param: "patterns",
  description:
    "Glob patterns for the contract files. Defaults to every contract under the composed source roots (contexts/*/src/**/*.contract.ts) — you rarely need to pass this.",
};

/** The findings flags of the two recording gates. The tool parameter carries
 *  the full item schema — what the model reads — while the CLI takes any JSON
 *  and lets the gate's own validation say what is wrong with it. */
function findingsFlags(schema: {
  readonly description: string;
  readonly evidence: string;
}): readonly FlagSpec[] {
  return [
    {
      name: "findings",
      kind: "json",
      param: "findings",
      required: true,
      description: "The findings as a JSON array. Pass [] to record that you found nothing.",
      jsonSchema: {
        type: "array",
        items: {
          type: "object",
          required: ["severity", "summary"],
          properties: {
            severity: {
              anyOf: [
                { type: "string", const: "blocker" },
                { type: "string", const: "concern" },
                { type: "string", const: "note" },
              ],
              description: "blocker | concern | note",
            },
            summary: { type: "string", description: "One line: what is wrong." },
            evidence: { type: "string", description: schema.evidence },
          },
        },
        description: schema.description,
      },
    },
    {
      name: "findings-file",
      kind: "string",
      cliOnly: true,
      description: "A file holding the findings as a JSON array — for a payload too long for a shell line.",
    },
  ];
}

/** A gate that could not run because of how it was called. Logged like any
 *  other error verdict: a misused gate is still a gate that did not pass. */
function misuse(name: string, cwd: string, message: string): GateResult {
  const result = gateError(name, message, "bad-invocation");
  logGuardEvent(cwd, { guard: name, verdict: "error", summary: message, detail: result.detail });
  return result;
}

/** Exactly one of `--findings` / `--findings-file`, parsed. An empty list is a
 *  claim the log keeps, so neither flag is not "no findings" — it is misuse. */
function findingsOf(
  name: string,
  cwd: string,
  args: GateArgs,
): { readonly ok: true; readonly findings: unknown } | { readonly ok: false; readonly result: GateResult } {
  const inline = argJson(args, "findings");
  const file = argString(args, "findings-file");
  if ((inline === undefined) === (file === undefined)) {
    return { ok: false, result: misuse(name, cwd, "pass exactly one of --findings <json> or --findings-file <path>") };
  }
  if (file === undefined) return { ok: true, findings: inline };
  let raw: string;
  try {
    raw = readFileSync(resolve(cwd, file), "utf8");
  } catch {
    return { ok: false, result: misuse(name, cwd, `cannot read --findings-file ${file}`) };
  }
  try {
    return { ok: true, findings: JSON.parse(raw) };
  } catch {
    return { ok: false, result: misuse(name, cwd, `--findings-file ${file} is not valid JSON`) };
  }
}

/** A `--flag` that must be a positive integer, or misuse. */
function positiveInteger(
  name: string,
  cwd: string,
  args: GateArgs,
  flag: string,
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false; readonly result: GateResult } {
  const value = argNumber(args, flag);
  if (value === undefined) return { ok: true, value };
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, result: misuse(name, cwd, `--${flag} needs a positive integer (got ${value})`) };
  }
  return { ok: true, value };
}

const patternsOf = (args: GateArgs): readonly string[] | undefined => {
  const patterns = argStrings(args, "pattern");
  return patterns.length > 0 ? patterns : undefined;
};

// --- the registry ------------------------------------------------------------------

export const gates: readonly GateCommand[] = [
  {
    name: "handoff-publish",
    description: "Publish a revision-bound handoff receipt after design-gate has frozen and the architect has committed the design. In a ticket-numbered TN project, the active ticket (recorded by lead prepare; BOUNDED_TICKET overrides) must match --producer; the receipt includes that TN and its owned contracts.",
    flags: [{ name: "producer", kind: "string", required: true, description: "The producing ticket's identity." }],
    async run(cwd, args) {
      const { runHandoffPublish } = await import("./scripts/handoff-publish.ts");
      return runHandoffPublish(cwd, argString(args, "producer") ?? "");
    },
  },
  {
    name: "contract-purity",
    tool: "contract_purity",
    promptSnippet: "Gate the contracts: declaration-only, no naked primitives.",
    description:
      "Run the contract-purity gate over the project's *.contract.ts files: contracts must be declaration-only AND free of naked primitives on their public surface. The cheap single check while you are still iterating on a contract; when the design is settled, run design_gate instead — it starts with this and carries the phase through freeze.",
    flags: [PATTERN_FLAG],
    async run(cwd, args) {
      const { runContractPurity } = await import("./scripts/contract-purity.ts");
      return toGateResult("contract-purity", await runContractPurity(cwd, patternsOf(args)));
    },
  },
  {
    name: "design-gate",
    tool: "design_gate",
    promptSnippet: "Run the design phase: purity, scaffold, typecheck, design-review, freeze.",
    description:
      "The one design-phase call: contract-purity → scaffold → project typecheck → design-review → freeze. In a ticket-numbered TN project, the active ticket recorded by lead prepare selects the TN (BOUNDED_TICKET overrides); review and freeze cover that TN and its listed contracts. Project typecheck remains project-wide. On a RE-freeze the review is checked first and worker-owned type drift may proceed; design-owned diagnostics still block.",
    flags: [PATTERN_FLAG],
    promptGuidelines: [
      "It will not freeze a design nobody has challenged: commission the `reviewer` subagent once first. A review covers the SET of contract files it saw, so editing one you revised in answer to it does not un-review the design — only adding or removing a contract file does, and then the step names the file.",
      "The reviewer's findings are advisory and blockers do not fail this gate — you keep authority over the design and may freeze over any finding, blocker included. The passing line prints the blocker count so an unsettled one stays visible.",
      "Re-run it after every contract revision to re-scaffold and re-freeze — that is the only way to do the last two — but do NOT re-commission the reviewer to chase findings; a fresh review is owed only when a contract file is added or removed.",
      "Every failure it reports is yours to fix — at DESIGN there is no test-writer or builder output for a defect to live in.",
      "While you are still iterating on a contract, `contract_purity` alone is the cheap check; `design_gate` is how the phase advances.",
    ],
    async run(cwd, args) {
      const { runDesignGate } = await import("./scripts/design-gate.ts");
      return await runDesignGate(cwd, patternsOf(args));
    },
  },
  {
    name: "change-diff",
    tool: "change_diff",
    promptSnippet: "Review the current design against its adopted or last-delivered baseline.",
    description:
      "Show a unified diff of the active ticket's design note, owned contracts, CONTEXT.md and ADRs against its adopted or last-delivered baseline. The reviewer should call this before recording a review on a change run.",
    flags: [],
    async run(cwd) {
      const { designDiff } = await import("./scripts/change-diff.ts");
      const diff = designDiff(cwd);
      return {
        code: 0,
        verdict: "pass",
        summary: `change diff: ${diff.paths.length} changed design files`,
        lines: [...diff.lines],
        detail: { fingerprint: diff.fingerprint, paths: diff.paths },
      };
    },
  },
  {
    name: "check-drift",
    tool: "check_drift",
    promptSnippet: "Check whether any contract has moved since it was frozen.",
    description:
      "Verify the active ticket's design note and owned contracts are unchanged since design_gate froze them. Legacy projects verify their project-wide contract set.",
    // Verify only. Recording the manifest is the freeze, and the freeze is a
    // step of design_gate (ADR 2026-019): a flag here would be a second way to
    // freeze, offered to every role that may run this. A person wanting a raw
    // freeze has `node packs/ts/scripts/checksum-gate.ts --write`.
    flags: [],
    async run(cwd) {
      const { runChecksumGate } = await import("./scripts/checksum-gate.ts");
      return toGateResult("check-drift", runChecksumGate(cwd, false));
    },
  },
  {
    name: "red-gate",
    tool: "red_gate",
    promptSnippet: "Gate the tests: is this a red for the right reason?",
    description:
      "Run the red gate after the test-writer finishes. A VALID red means the project typechecks, the suite runs, and every test fails with NotImplementedError against regenerated skeletons. Wrong-reason failures, passing tests and skipped tests are rejected. The gate prints one `route → <role>` line naming who must fix what it found.",
    flags: [],
    async run(cwd) {
      const { runRedGate } = await import("./scripts/red-gate.ts");
      return await runRedGate(cwd);
    },
  },
  {
    name: "generate-artifacts",
    tool: "generate_artifacts",
    promptSnippet: "Generate selected packs' project artifacts after the builder changes their inputs.",
    description: "Run the deterministic artifact generators this project's selected capabilities contribute, writing files no role may write by hand. Call after the builder changes a generator's input and before green_gate, then review the generated files. Refuses before design_gate has frozen the design, and when the project config has drifted from what the packs generate.",
    flags: [],
    async run(cwd) {
      const { runArtifactGenerators } = await import("./scripts/generate-artifacts.ts");
      return runArtifactGenerators(cwd);
    },
  },
  {
    name: "green-gate",
    tool: "green_gate",
    promptSnippet: "Gate the build: tests pass AND the project compiles.",
    description:
      "Run the green gate after the builder finishes. GREEN means every test passes AND the project typechecks — a passing suite on a project that does not compile is a false green, not a pass. The gate prints one `route → <role>` line naming who must fix what it found.",
    flags: [],
    async run(cwd) {
      const { runGreenGate } = await import("./scripts/green-gate.ts");
      const r = await runGreenGate(cwd);
      // Green is not the terminal verdict. Run 7's architect found a real
      // defect in its closing turn and shipped anyway, because a gate verdict
      // was the only way the loop could end.
      if (r.code !== 0) return r;
      return {
        ...r,
        lines: [
          ...r.lines,
          "green-gate: GREEN is not the terminal verdict — call sign_off with what you saw reading the code (an empty list is a valid answer).",
        ],
      };
    },
  },
  {
    name: "sign-off",
    tool: "sign_off",
    promptSnippet: "Sign off on the green: what did you see?",
    description:
      "End the loop. After a passing green gate, record what you saw reading the implementation and the tests — you are the only role that can read both. An EMPTY findings list is a valid and expected answer; recording it explicitly is the point, because a silence cannot be audited later. This gate never judges a finding, it records the claim. Refuses if no green gate has passed.",
    flags: findingsFlags({
      description: "What you saw. Pass [] to record that you found nothing.",
      evidence: "Where to look — a path, a symbol, a test name.",
    }),
    promptGuidelines: [
      "Call this after green_gate passes and before telling the user the work is done.",
      "Record anything the gates could not see: a type-system escape hatch, an untested export, behaviour the spec left unstated, an ordering two roles agreed on only by luck.",
      "severity: 'blocker' means do not ship it as clean; 'concern' means worth a look; 'note' is an observation.",
    ],
    async run(cwd, args) {
      const findings = findingsOf("sign-off", cwd, args);
      if (!findings.ok) return findings.result;
      const { runSignOff } = await import("./scripts/sign-off.ts");
      return runSignOff(cwd, findings.findings);
    },
  },
  {
    name: "deliver",
    tool: "deliver",
    promptSnippet: "Deliver: strip scaffolding, ship the surface check, make the repo hand-off ready.",
    description:
      "Run the delivery pass after sign_off: remove the red-phase errors modules (each context's domain/shared/errors.ts) and the red gate's shadow project, check every generated file is what the design produces and no skeleton still throws NotImplementedError, check the shipped scripts/surface-check.ts is wired into the project's check, ignore runtime state under .bounded/ while preserving a committed local harness, and add the README Contracts section. Then prints where the run's minutes went — design/tests/build/wrap durations and bounces, read back from the guard log — and finally runs the project's own `bun run check` as the last word on whether the repo satisfies its own definition of done. Idempotent — a second run applies nothing. Blocks if anything still imports NotImplementedError, if a generated file is out of date, or if the project's own check is red.",
    flags: [],
    async run(cwd) {
      const { runDeliver } = await import("./scripts/deliver.ts");
      return toGateResult("deliver", await runDeliver(cwd));
    },
  },
  {
    name: "mutation-score",
    tool: "mutation_score",
    promptSnippet: "Measure the suite's mutation score: which edits to the source does nobody notice?",
    description:
      "Measure how much of the delivered logic the suite actually holds down: mutate the builder's source under the source roots one site at a time (comparison flips, &&/|| swaps, if-negation, dropped early-return guards), run the suite against each mutant, and report which were KILLED and which SURVIVED. ADVISORY — it never blocks: exit 0 means the measurement ran, whatever the score. Each surviving mutant names a file, a line and an edit the suite did not notice, which is where an untested rule lives. Run it after green_gate and before sign_off, and put what survived in your findings.",
    flags: [
      {
        name: "max-mutants",
        kind: "number",
        param: "maxMutants",
        description:
          "Cap on mutants run (default 40). Each one costs a full suite run, so raise it only on a fast suite.",
      },
      {
        name: "timeout-ms",
        kind: "number",
        param: "timeoutMs",
        description: "Per-mutant suite timeout in milliseconds; a mutant that outlives it counts as timed out.",
      },
    ],
    promptGuidelines: [
      "A survivor is not automatically a defect — it is a question. Read the line it names and decide whether the rule it broke is one the spec actually requires.",
      "The measurement costs one full suite run per mutant (40 by default), so run it once, late, on a green suite — not between builder bounces.",
      "Findings from it belong in sign_off: 'the suite does not hold down X' is exactly the kind of thing only you can see, and the gates cannot.",
    ],
    async run(cwd, args) {
      const maxMutants = positiveInteger("mutation-score", cwd, args, "max-mutants");
      if (!maxMutants.ok) return maxMutants.result;
      const timeoutMs = positiveInteger("mutation-score", cwd, args, "timeout-ms");
      if (!timeoutMs.ok) return timeoutMs.result;
      const { runMutationScore } = await import("./scripts/mutation-score.ts");
      const r = await runMutationScore(cwd, {
        ...(maxMutants.value !== undefined ? { maxMutants: maxMutants.value } : {}),
        ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
      });
      return toGateResult("mutation-score", r, {
        sites: r.sites,
        killed: r.killed,
        survived: r.survived,
        timedOut: r.timedOut,
        score: r.score ?? null,
      });
    },
  },
  {
    name: "typecheck",
    tool: "typecheck",
    promptSnippet: "Type-check the project with bunx tsc (scoped to your zone).",
    description:
      "Run `bunx tsc -p tsconfig.json` on the project and return pass/fail plus type-error diagnostics. Absolute machine paths are redacted. Diagnostics are SCOPED TO YOUR ROLE: errors in your own zone and in the shared interface (contracts, spec, config) are shown in full; errors in another role's zone are reported as a count and an owner only — no paths, no messages, no symbol names.",
    flags: [
      {
        name: "role",
        kind: "string",
        cliOnly: true,
        description:
          "Scope the diagnostics to this pipeline role (architect | test-writer | builder | reviewer). Unscoped when absent.",
      },
    ],
    promptGuidelines: [
      "Use typecheck to confirm your implementation compiles before relying on run_tests.",
      "Errors reported as another role's are not yours to fix and do not block you — never redesign your code around them, and never ask for their content; report them to the architect if they seem to block the ticket.",
      "'clean in your zone' is not 'the project compiles': it means nothing is left for YOU to fix.",
    ],
    async run(cwd, args) {
      const { parseRole, typecheckGate } = await import("./scripts/typecheck-gate.ts");
      // The role is the HOST's to supply, never this gate's to resolve: the pi
      // tool injects the session's binding (hosts/pi/extensions/lib/gate-tools.ts) and
      // the CLI maps BOUNDED_DEV_STAGE_ROLE (src/gates-cli.ts). Resolving it here
      // against `cwd` was Run 15's hole — `cwd` is the TARGET, and a target
      // subdirectory holds no role file, so the answer came back unscoped.
      const raw = argString(args, "role");
      if (raw === undefined) return await typecheckGate(cwd);
      const role = parseRole(raw);
      if (role === undefined) {
        return misuse("typecheck", cwd, `--role must be one of architect | test-writer | builder | reviewer (got '${raw}')`);
      }
      return await typecheckGate(cwd, role);
    },
  },
  {
    name: "run-tests",
    tool: "run_tests",
    promptSnippet: "Run the test suite and see sanitized pass/fail results (no test source).",
    description:
      "Run the project's suite with `bun test` and return sanitized results: failing test names and assertion diffs only. Code frames, stack traces, file paths, and console output are stripped — you cannot see test source, only outcomes.",
    flags: [],
    promptGuidelines: [
      "Use run_tests to check whether your implementation satisfies the suite; it never reveals test source.",
    ],
    async run(cwd) {
      const { runTestsGate } = await import("./scripts/run-tests.ts");
      return await runTestsGate(cwd);
    },
  },
  {
    name: "record-design-review",
    tool: "record_design_review",
    promptSnippet: "Record the challenges you raise reading the design note and owned contracts.",
    description:
      "Record challenges from the active ticket's TN and owned contracts (or legacy spec and contracts). Findings are claims for the architect to weigh; an empty list is a valid review. A changed file remains covered, while a contract added or removed from ownership requires a fresh review.",
    flags: findingsFlags({
      description: "What you found. Pass [] to record that you found nothing.",
      evidence: "Where to look — a path, a symbol, an exported operation.",
    }),
    promptGuidelines: [
      "Call this once, at the end of the review, with everything you found — it is the only output of the role, and you are not re-run to re-check.",
      "severity: 'blocker' is the challenge you would stake most on — the pipeline looks set to jam (an operation nobody can call, a type nobody can construct, two requirements that contradict) — still advisory, the architect may freeze over it; 'concern' means two careful implementers could read it differently; 'note' is everything else.",
      "Pass [] when you found nothing. A clean review that is recorded can be audited later; a silence cannot.",
    ],
    async run(cwd, args) {
      const findings = findingsOf("record-design-review", cwd, args);
      if (!findings.ok) return findings.result;
      const { runRecordDesignReview } = await import("./scripts/design-review.ts");
      return runRecordDesignReview(cwd, findings.findings);
    },
  },
  // CLI-only from here: no pi tool. surface-check ships INTO the delivered
  // project (deliver.ts) and so must stay free of harness imports, which is why
  // it logs nothing itself — the event is written here, at the boundary.
  {
    name: "surface-check",
    description:
      "Check every contract under the source roots against what implements it: a domain concept's file ends with exactly its two generated exports and exports nothing else; a feature's handler exports only `<InPort>Handler implements <InPort>`, whose only public member is execute. The same check runs in the project as `bun run check:surface`.",
    flags: [],
    async run(cwd) {
      const { checkProjectSurfaces } = await import("./scripts/surface-check.ts");
      const { sourceRoots } = await import("../../src/pack-contrib.ts");
      // The composed roots; a project with no readable composition (a
      // delivered repo) falls back to the roots its own manifest implies.
      let roots: readonly string[] | undefined;
      try {
        roots = sourceRoots(cwd);
      } catch {
        roots = undefined;
      }
      const r = roots === undefined ? checkProjectSurfaces(cwd) : checkProjectSurfaces(cwd, roots);
      const result = toGateResult("surface-check", r, { violations: r.violations.length });
      logGuardEvent(cwd, {
        guard: "surface-check",
        verdict: guardVerdictOf(r.code),
        summary: result.summary,
        detail: { violations: r.violations },
      });
      return result;
    },
  },
  // A step of design_gate, not a tool (ADR 2026-019): exposed on the command
  // line for a person regenerating skeletons by hand, never to a role.
  {
    name: "scaffold",
    description:
      "Run every composed emitter over the design: write generated files when they differ and skeletons only where no file exists, remove generated files the design no longer produces, and bring the workspace manifests, lockfile and install in line when the design adds a workspace. A step of design_gate — run it alone only to regenerate by hand.",
    flags: [],
    async run(cwd) {
      const { runScaffold } = await import("./scripts/scaffold-project.ts");
      return toGateResult("scaffold", runScaffold(cwd));
    },
  },
];
