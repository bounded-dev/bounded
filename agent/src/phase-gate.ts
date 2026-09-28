// Phase gate: a worker spawn is a transition, and transitions are checked.
//
// Every other gate checks an ARTIFACT — is this contract pure, is this red the
// right red. None of them checked the SEQUENCE, so a step could simply not be
// reached and nothing would notice. Across three consecutive dogfood attempts
// on one prompt the architect froze the contracts with no `spec.md` every time,
// and only wrote one afterwards because it happened to.
//
// The spec is not paperwork. It carries the half of the interface types cannot
// hold: execution order, the exact rounding tie-break, identity guarantees. A
// test-writer handed 38 typed operations and no spec can pin signatures and
// nothing else — which is exactly the class of test the bare arm already
// writes, and the harness's whole measured advantage lives in the difference.
//
// So the spawn itself is gated. Commissioning a worker is a tool call, the path
// gate already sees every tool call, and a spawn whose preconditions are unmet
// is refused. The rule stops being "the skill says do this first" and becomes
// something with no way around it.
//
// Evidence comes from the guard log, which every gate already writes. That
// makes the log load-bearing rather than merely diagnostic: it is the record of
// what actually ran, so it is the right thing to ask.
//
// WHAT THE GATE CHECKS, AND WHAT IT NO LONGER DOES (ADR 2026-021)
//
// The precondition for a worker is the FREEZE, not the red. red_gate proves red
// in a shadow project it builds itself — contracts plus regenerated skeletons
// plus the tests tree, never the live `src/` — and green_gate requires the
// standing red to match the current tests-tree hash. So a red is bound to the
// bytes it was proven against rather than to a moment in the run, and
// sequencing the builder behind it bought nothing the hashes do not already
// hold. The test-writer and the builder are therefore commissioned in parallel
// once DESIGN is complete, and nothing here enforces an order between them.
//
// Two spawn SHAPES are refused outright, because both were observed live
// carrying pipeline work past every check in this file:
//
//   * a multi-spawn form (`workflowScript`, or a `chain`/`parallel` item array)
//     that names a pipeline role — the gate sees one tool call and cannot
//     evaluate a precondition per child inside a script it never watches run,
//     and the per-role model tier is injected at the plain spawn too;
//   * `delegate`, the general write-capable worker, in a session that already
//     holds a bound role — inside the developer stage every writer is a role
//     with a zone, and an unbound one writes wherever it likes.
//
// RESUMES ARE COMMISSIONS TOO (r15)
//
// A third shape was passing through untouched: `action: "resume"`. r15's kimi
// architect made twelve of them and not one produced a phase-gate or a
// model-tier event, so twelve seats went back to work with nothing in the log
// to say which roles were running or on what. A resume is not a launch — the
// child already exists, its preconditions were checked when it was launched,
// and refusing one would strand a run — but it IS a seat being commissioned,
// and it is recorded as one. Where the call names a role, the two refusals
// that are about the SHAPE of a commission rather than its phase apply
// unchanged: `delegate` holds no role binding whether it is starting or
// continuing, and a multi-spawn form is still a set of children this gate
// cannot see. Where it names only a run id — the ordinary case, since
// pi-subagents resolves the agent from the persisted run record and not from
// the input — the event carries the run id and the role `unknown`, which is
// strictly better than silence.
//
// AND A TIER THAT CANNOT RESOLVE IS A REFUSAL (r15)
//
// r15's first kimi reviewer ran on the session default, because the project's
// configured `kimi-k3:high` matched nothing in the live registry. The tier
// injection skipped, correctly — pi-subagents throws on an unresolvable
// explicit model — and the spawn then went ahead anyway, which is the part
// that was wrong: a judgment seat ran on a model nobody chose, silently. So a
// spawn whose role HAS a configured tier that the registry cannot resolve is
// refused here instead. The never-fatal rule for the config itself is
// untouched: no file, no key, a malformed file, or no registry snapshot all
// mean no policy, and no policy means allowed.

import type { LoggedGuardEvent } from "./guard-log.ts";
import type { Role } from "./path-policy.ts";
import type { DevStageModels } from "./dev-stage-models.ts";
import { DEV_STAGE_MODELS_RELATIVE } from "./dev-stage-models.ts";
import {
  isResumeCall,
  resumeRunId,
  spawnAgentName,
  unresolvableTier,
  type KnownModel,
} from "./model-tier.ts";

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export interface PhaseEvidence {
  /** Active ticket for projects that use ticket-numbered TNs. */
  readonly ticket?: string;
  /** Current hashes of this ticket's TN and owned contracts. */
  readonly designHashes?: Readonly<Record<string, string>>;
  /** Project-relative paths of the contract files that exist — recognised by
   *  the filename suffixes the composed packs contribute (ADR 2026-052). */
  readonly contracts: readonly string[];
  /** The composed packs' contract filename suffixes, for refusal wording. */
  readonly contractSuffixes?: readonly string[];
  /** Full text of spec.md; "" when absent or unreadable. */
  readonly specText: string;
  /** The project's guard log, oldest first. */
  readonly events: readonly LoggedGuardEvent[];
  /** Stack nouns contributed by installed packs (TN-26-005) that must not
   *  survive intake into the spec body. Absent or empty = no contributions,
   *  and the noun check is vacuous — never a refusal. */
  readonly techNouns?: readonly string[];
  /**
   * The project's seat→model tiers. Absent means the caller could not read
   * them, which is the same as none being configured: no policy, no refusal.
   */
  readonly models?: DevStageModels;
  /**
   * Snapshot of the session's available models. Absent or empty means "cannot
   * tell", never "bad" — a missing snapshot must not turn into a refusal.
   */
  readonly known?: readonly KnownModel[];
}

/**
 * Minimum size for a spec to count as written.
 *
 * A mere existence check is satisfied by `touch spec.md`, and a gate that can
 * be satisfied without doing the work is theatre. This is not a quality bar —
 * nothing deterministic can judge a spec — it is a floor that a real document
 * clears without thinking and a placeholder does not. Live specs have run
 * 147–335 lines, so a few hundred bytes is far below anything genuine.
 */
const MIN_SPEC_BYTES = 400;

// --- intake (ADR 2026-032) -------------------------------------------------------
//
// Every spec entering the stage is reworked to "what is required", and the
// implementation choices stripped in that rework are recorded under an
// `## Intake` heading — including the empty case ("nothing stripped"), so the
// act is always visible and the reviewer always has something to challenge.
//
// The noun denylist is the crude mechanical backstop: names of non-blessed
// stacks appearing OUTSIDE the Intake section are a "how" that survived
// intake. The Intake section itself is exempt on purpose — a stripped how is
// *recorded* there, and a user-ratified constraint is *documented* there,
// both by name.
//
// THE NOUNS ARE NOT CORE CONTENT (TN-26-005). This gate is the socket; the
// words are pack contributions, merged from the installed packs'
// contrib.json manifests by src/pack-contrib.ts and handed in as evidence.
// A harness composed without a pack lacks that pack's nouns — the core names
// no technology. Bare English collisions ("express" the verb) are accepted:
// the refusal asks for a reword, which costs a minute and keeps the check
// deterministic.

const INTAKE_HEADING = /^(#{2,6})\s+intake\b.*$/im;

/**
 * The body of the spec's Intake section, or undefined when no `## Intake`
 * heading exists. The section runs to the next heading of the same or a
 * shallower level, or to the end of the text.
 */
export function specIntakeSection(specText: string): string | undefined {
  const match = INTAKE_HEADING.exec(specText);
  if (match === null || match.index === undefined) return undefined;
  const level = match[1]!.length;
  const bodyStart = match.index + match[0].length;
  const rest = specText.slice(bodyStart);
  const next = new RegExp(`^#{1,${level}}\\s`, "m").exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/**
 * Denylisted stack nouns appearing OUTSIDE the Intake section, unique and
 * sorted. Word-bounded, case-insensitive; the Intake body is excised first,
 * because that is exactly where a stripped or user-ratified "how" is
 * legitimately named.
 */
export function techNounsOutsideIntake(specText: string, nouns: readonly string[]): string[] {
  let body = specText;
  const intake = specIntakeSection(specText);
  if (intake !== undefined) body = specText.replace(intake, "");
  const found = new Set<string>();
  for (const noun of nouns) {
    const pattern = new RegExp(`(?<![\\w-])${noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
    if (pattern.test(body)) found.add(noun);
  }
  return [...found].sort();
}

/** Roles the phase gate governs. Anything else spawns freely. */
const GATED_TARGETS = new Set(["test-writer", "builder"]);

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

/** Index of the last event matching a predicate, or -1. */
function lastIndexWhere(
  events: readonly LoggedGuardEvent[],
  pred: (e: LoggedGuardEvent) => boolean,
): number {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i]!)) return i;
  return -1;
}

/** The latest verdict for a guard, or undefined if it never ran. */
function latestVerdict(
  events: readonly LoggedGuardEvent[],
  guard: string,
): LoggedGuardEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.guard === guard) return events[i];
  }
  return undefined;
}

/** Has `guard` most recently passed? A later block supersedes an earlier pass. */
function passed(events: readonly LoggedGuardEvent[], guard: string): boolean {
  return latestVerdict(events, guard)?.verdict === "pass";
}

/**
 * May the architect spawn `target` given the current evidence?
 *
 * Each refusal names the tool that would satisfy it, so the architect can act
 * on the message rather than guess — and says WHY, because a rule whose purpose
 * is invisible reads as bureaucracy and gets worked around.
 */
/** How a refusal names a contract file: by the composed suffixes when known. */
function contractKind(suffixes: readonly string[] | undefined): string {
  return suffixes?.length ? suffixes.map((suffix) => `*${suffix}`).join(" or ") : "contract file";
}

export function checkSpawnPrecondition(target: string, evidence: PhaseEvidence): Decision {
  if (!GATED_TARGETS.has(target)) return ALLOW; // scout, product-expert, …

  const { contracts, specText, events } = evidence;
  const specBytes = Buffer.byteLength(specText, "utf8");
  const note = evidence.ticket ? `docs/tn/TN-${evidence.ticket}.md` : "spec.md";

  if (contracts.length === 0) {
    return deny(
      `phase-gate: cannot commission the ${target} — no ${contractKind(evidence.contractSuffixes)} exists yet. ` +
        "The contract is the shared interface both blind roles build against; without it they have nothing to agree on.",
    );
  }

  if (specBytes === 0) {
    return deny(
      `phase-gate: cannot commission the ${target} — ${note} is missing. ` +
        "The contract carries the half its type declarations can hold; the spec carries the rest — execution " +
        "order, the exact arithmetic and its tie-break, identity guarantees. Two blind agents cannot " +
        'agree on "round to the nearest cent"; they can agree on floor((2n + d) / 2d). Write it, then commission.',
    );
  }

  if (specBytes < MIN_SPEC_BYTES) {
    return deny(
      `phase-gate: cannot commission the ${target} — ${note} is ${specBytes} bytes, which is a ` +
        "placeholder rather than a document. It must carry the ordering, arithmetic and identity " +
        "rules the contract cannot express.",
    );
  }

  if (specIntakeSection(specText) === undefined) {
    return deny(
      `phase-gate: cannot commission the ${target} — ${note} has no "## Intake" section ` +
        "(ADR 2026-032). Every ticket is reworked to what-is-required, and the Intake section " +
        "records the implementation choices stripped in that rework — \"nothing stripped\" is a " +
        "valid entry — so the reviewer can challenge the reworking. Add it, then commission.",
    );
  }

  const leaked = techNounsOutsideIntake(specText, evidence.techNouns ?? []);
  if (leaked.length > 0) {
    return deny(
      `phase-gate: cannot commission the ${target} — ${note} names ${leaked.join(", ")} outside ` +
        "the Intake section. A technology a ticket names is a \"how\" that intake strips (ADR " +
        "2026-032): remove it from the requirement text, or — if the user has ratified it as a " +
        "genuine constraint — document it under \"## Intake\" with that rationale, where it is legal.",
    );
  }

  if (evidence.ticket !== undefined) {
    const latest = [...events].reverse().find((e) => e.guard === "design-gate" &&
      (e.detail as { ticket?: unknown } | undefined)?.ticket === evidence.ticket);
    if (latest?.verdict !== "pass") {
      return deny(`phase-gate: cannot commission the ${target} — ticket #${evidence.ticket} has no standing design-gate freeze`);
    }
    const frozen = (latest.detail as { frozenDesign?: unknown } | undefined)?.frozenDesign;
    const current = evidence.designHashes ?? {};
    const owned = (latest.detail as { ownedPaths?: unknown } | undefined)?.ownedPaths;
    if (!Array.isArray(owned) || owned.some((path) => typeof path !== "string") ||
      JSON.stringify([...owned].sort()) !== JSON.stringify(Object.keys(current).sort()) ||
      typeof frozen !== "object" || frozen === null || Object.entries(current).some(([path, hash]) =>
      (frozen as Record<string, unknown>)[path] !== hash)) {
      return deny(`phase-gate: cannot commission the ${target} — ticket #${evidence.ticket} changed since its design freeze`);
    }
  } else {
  // The three checks below read the INNER guard names, which `design_gate` logs
  // as it runs each step (ADR 2026-019). So they still say precisely which step
  // is missing, and the remedy for every one of them is the same single call.
  if (!passed(events, "contract-purity")) {
    return deny(
      `phase-gate: cannot commission the ${target} — contract_purity has not passed on the current ` +
        "contract. Run design_gate — contract-purity is its first step — and fix what it reports first.",
    );
  }

  if (!passed(events, "scaffold")) {
    return deny(
      `phase-gate: cannot commission the ${target} — the skeletons have not been generated. Run ` +
        "design_gate: its scaffold step writes the throwing stubs the red phase runs against, so " +
        "without them there is nothing to fail.",
    );
  }

  if (!passed(events, "checksum-gate")) {
    return deny(
      `phase-gate: cannot commission the ${target} — the contract is not frozen. Run ` +
        "design_gate: its freeze step records the checksum manifest, so a contract that moves " +
        "underneath the workers is detectable rather than silent.",
    );
  }
  }

  // A cold launch of a role that has already run re-primes an entire context.
  // Run 6 spent ~1.6M cache-read tokens — about a quarter of the run — starting
  // over with agents that already knew the task: 1.75M for the first builder,
  // then 649k, 603k and 362k re-priming its successors.
  //
  // pi retains completed children, so a bounce should CONTINUE one rather than
  // start another. The architect must consult the retained list before it may
  // launch cold; consulting and then launching is fine, because that is the
  // legitimate case where the child was not resumable. What is refused is
  // respawning without looking. `children.list` is itself a subagent call, so
  // the gate sees it — the evidence is the architect's own tool calls, and no
  // knowledge of pi's internal state is needed.
  const lastSpawn = lastIndexWhere(
    events,
    (e) => e.guard === "phase-gate" && (e.detail as { kind?: string } | undefined)?.kind === "spawn"
      && (e.detail as { target?: string }).target === target,
  );
  if (lastSpawn !== -1) {
    const consulted = lastIndexWhere(
      events,
      (e) =>
        e.guard === "phase-gate" &&
        (e.detail as { kind?: string } | undefined)?.kind === "children-listed",
    );
    if (consulted < lastSpawn) {
      return deny(
        `phase-gate: a ${target} has already run — do not launch a second one cold. ` +
          "A cold launch re-primes the whole context; Run 6 spent about a quarter of its tokens " +
          "re-teaching agents what they already knew. Continue the existing child instead: " +
          '`{ action: "children.list" }` to find its run id and whether it is resumable, then ' +
          '`{ action: "resume", id: "<run-id>", message: "<the bounce>" }`. ' +
          "If children.list reports it not resumable, launch again and it will be allowed.",
      );
    }
  }

  // Nothing below this line orders the two workers. The builder used to wait on
  // a red-gate pass; it no longer does (ADR 2026-021). red_gate proves red in a
  // shadow project built from the contracts, regenerated skeletons and the
  // tests tree, so it never reads live `src/` and a builder working in parallel
  // cannot contaminate it; green_gate then requires the standing red to match
  // the current tests-tree hash, so a red that no longer describes the suite is
  // void whether or not it was established first. Ordering was enforcing what
  // the hashes already prove, at the cost of a serialized phase.

  return ALLOW;
}

// ---------------------------------------------------------------------------
// The spawn FORM, not just the spawn target.
// ---------------------------------------------------------------------------
//
// Everything above assumes one child per tool call, named in the call. Two
// live runs showed that assumption is not free:
//
//   * r13/r14, twice: the architect wrapped both workers in a `workflowScript`
//     (`runs.all([...])`). The gate saw one `subagent` call carrying a string,
//     found no `agent`, and let it through — the builder ran with no
//     precondition checked and no model tier injected.
//   * twice more: the architect spawned `delegate`, the general write-capable
//     worker, inside the pipeline. `delegate` carries no role binding, so the
//     path gate has no zone to apply to it and it writes anywhere.
//
// Both are refused by SHAPE, which is the only thing a gate can check here: it
// cannot follow a script it never watches run, and it cannot bind a role to a
// child it never sees named.

/** The pipeline roles, as names to be matched inside a script or item array. */
const PIPELINE_ROLE_NAMES: readonly Role[] = ["architect", "test-writer", "builder", "reviewer"];

/**
 * Subagent input fields that can carry MORE THAN ONE child in a single call.
 *
 * `workflowScript` is the live one (pi-subagents runs it as a statement body
 * over `runs.run`/`runs.all`). `chain` and `parallel` are the item-array forms
 * the same schema models; they are covered here so the rule is about the shape
 * rather than about one field name that happens to be current.
 */
const MULTI_SPAWN_FIELDS = ["workflowScript", "chain", "parallel"] as const;

/** Word-boundary mention of a pipeline role. Blunt on purpose: a script that
 *  merely talks about the builder is refused too, and rewording it costs a
 *  sentence, while a missed spawn costs an ungated worker. */
const ROLE_MENTION = new RegExp(`\\b(?:${PIPELINE_ROLE_NAMES.join("|")})\\b`, "g");

/** A multi-spawn form found in a subagent input. */
export interface MultiSpawnForm {
  /** The field that carried it: "workflowScript", "chain", "parallel". */
  readonly field: string;
  /** Pipeline roles named anywhere inside it, deduplicated, in role order. */
  readonly roles: readonly string[];
}

/** The multi-spawn form this input carries, if any, and the roles it names. */
export function detectMultiSpawn(
  input: Readonly<Record<string, unknown>>,
): MultiSpawnForm | undefined {
  for (const field of MULTI_SPAWN_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const text = typeof value === "string" ? value : safeStringify(value);
    const found = new Set(text.match(ROLE_MENTION) ?? []);
    return { field, roles: PIPELINE_ROLE_NAMES.filter((r) => found.has(r)) };
  }
  return undefined;
}

/** JSON with cycles and unserializable values degraded, never thrown. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The general write-capable worker — no role, therefore no zone. */
const UNBOUND_WRITER = "delegate";

/** What the wiring should do with one `subagent` tool call. */
export type SpawnVerdict =
  /** Not a launch (status/steer/resume/…): never refuse, never record. */
  | { readonly kind: "ignore" }
  /** `children.list` — record the consult that licenses a later cold launch. */
  | { readonly kind: "children-listed" }
  /** A plain one-child spawn, permitted. */
  | { readonly kind: "allow"; readonly target: string }
  /**
   * A resume of an existing child: always permitted, always recorded. `target`
   * is the role the call names, or "unknown" when it names only a run.
   */
  | { readonly kind: "resumed"; readonly target: string; readonly run: string }
  /** A fan-out naming no pipeline role: allowed, but recorded. */
  | { readonly kind: "allow-multi"; readonly form: MultiSpawnForm }
  /** Refused, with the line the architect reads. */
  | {
      readonly kind: "block";
      readonly reason: string;
      readonly target?: string;
      readonly form?: MultiSpawnForm;
    };

/**
 * Decide one `subagent` call made by a session that holds a bound pipeline role.
 *
 * The bound-role condition is the caller's (the path gate is inactive without
 * one), and it is what makes rule 3 correct: `delegate` is an ordinary worker
 * in an ordinary session and is refused only INSIDE the pipeline.
 */
export function checkSubagentCall(
  input: Readonly<Record<string, unknown>>,
  evidence: PhaseEvidence,
): SpawnVerdict {
  const action = input["action"];
  if (typeof action === "string") {
    if (action === "children.list") return { kind: "children-listed" };
    // A resume is a commission, so it is recorded — and the two SHAPE refusals
    // below apply to it exactly as they do to a launch. It is never refused for
    // a PHASE reason: the child already exists and its preconditions were
    // checked when it was launched, so blocking here would strand a run.
    if (isResumeCall(input)) return checkResume(input, evidence);
    // status/wait/stop/steer on an existing child must never be refused, or a
    // blocked architect could not even inspect what it started.
    if (action !== "launch" && action !== "run") return { kind: "ignore" };
  }

  // Shape first: a multi-spawn form is refused whatever the phase, because the
  // objection is that the gate cannot see the children at all.
  const form = detectMultiSpawn(input);
  if (form !== undefined) {
    if (form.roles.length === 0) return { kind: "allow-multi", form };
    return {
      kind: "block",
      form,
      reason:
        `phase-gate: this ${form.field} commissions pipeline roles (${form.roles.join(", ")}) — ` +
        "spawn them one at a time through the plain form instead: " +
        '`{ agent: "test-writer", task: "…" }`, one call per role. The gate cannot evaluate a ' +
        "precondition per child inside a script it never watches run, and the model-tier injection " +
        "that gives each role its model cannot reach a child spawned there either — so a role " +
        "commissioned this way runs ungated and on the wrong model. A multi-spawn form that names " +
        "no pipeline role is left alone.",
    };
  }

  const target = spawnTarget(input);
  if (target === undefined) return { kind: "ignore" };

  if (target === UNBOUND_WRITER) {
    return {
      kind: "block",
      target,
      reason:
        "phase-gate: delegate holds no role binding — inside the developer stage every writer is a " +
        "bound role. Generated-file cleanup happens in design_gate's scaffold sync; implementation " +
        "belongs to the builder; tests to the test-writer. Commission the role that owns the work; " +
        "`scout` and `product-expert` stay available for read-only help.",
    };
  }

  const decision = checkSpawnPrecondition(target, evidence);
  if (!decision.allow) return { kind: "block", reason: decision.reason, target };

  // Last: the seat's model. Checked after the phase preconditions because a
  // spawn that is too early is too early whatever it would have run on, and the
  // architect should fix one thing at a time.
  const tier = checkTierResolvable(target, evidence);
  if (tier !== undefined) return { kind: "block", reason: tier, target };

  return { kind: "allow", target };
}

/**
 * A resume: recorded, and refused only on the two shape grounds.
 *
 * `delegate` is refused whether it is being started or continued — the
 * objection is that it holds no role binding, and continuing an unbound writer
 * is continuing an unbound writer. A multi-spawn form is refused for the same
 * reason it is at launch: `action: "resume"` accepts a `chain`, which attaches
 * a whole sequence of children this gate never watches run.
 */
function checkResume(
  input: Readonly<Record<string, unknown>>,
  evidence: PhaseEvidence,
): SpawnVerdict {
  const run = resumeRunId(input) ?? "unnamed run";
  const named = spawnAgentName(input);

  const form = detectMultiSpawn(input);
  if (form !== undefined && form.roles.length > 0) {
    return {
      kind: "block",
      form,
      reason:
        `phase-gate: this resume attaches a ${form.field} that commissions pipeline roles ` +
        `(${form.roles.join(", ")}) — resume the child on its own ` +
        '(`{ action: "resume", id: "<run-id>", message: "…" }`) and commission anything else ' +
        "one call at a time. The gate cannot evaluate a precondition per child inside a script " +
        "it never watches run, and the model-tier injection cannot reach a child spawned there.",
    };
  }

  if (named === UNBOUND_WRITER) {
    return {
      kind: "block",
      target: named,
      reason:
        "phase-gate: delegate holds no role binding, and resuming one continues an unbound " +
        "writer rather than starting a fresh one — inside the developer stage every writer is a " +
        "bound role with a zone. Commission the role that owns the work; `scout` and " +
        "`product-expert` stay available for read-only help.",
    };
  }

  // The role is the caller's claim when it makes one. pi-subagents resolves the
  // agent from the persisted run record rather than from the input
  // (`resolveResumeTarget` matches on id/runId/dir alone), so the ordinary
  // resume names no role at all — and "unknown, this run id" is the honest
  // answer, and still an answer.
  return { kind: "resumed", target: named ?? "unknown", run };
}

/**
 * The refusal for a seat whose configured tier the registry cannot resolve, or
 * undefined when there is nothing wrong.
 *
 * The facts come from `unresolvableTier`; the prose is here, with every other
 * spawn refusal. It names the file, the key, the pattern that failed, and both
 * ways out — because "your model is wrong" without the file it is wrong in is
 * a message that costs a turn to act on.
 */
export function checkTierResolvable(
  target: string,
  evidence: PhaseEvidence,
): string | undefined {
  const { models, known } = evidence;
  if (models === undefined) return undefined; // could not read the config ⇒ no policy
  const bad = unresolvableTier(target, models, known ?? []);
  if (bad === undefined) return undefined;
  return (
    `phase-gate: cannot commission the ${target} — ${DEV_STAGE_MODELS_RELATIVE} sets ` +
    `"${bad.key}": "${bad.model}", and this session's model registry knows no such model. ` +
    "A seat whose tier is configured must run on it: passing the pattern through would make the " +
    "spawn fail outright, and dropping it would run this seat on the session default without " +
    "saying so — which is how r15's reviewer, a judgment seat, quietly ran on whatever the " +
    `session happened to be. Fix the pattern in ${DEV_STAGE_MODELS_RELATIVE} (` +
    "`pi --list-models '<pattern>'` shows what resolves; the value is a full provider/id, " +
    'optionally with a thinking suffix, e.g. "anthropic/claude-opus-4:high"), or remove the key ' +
    "to run this seat on the session default deliberately."
  );
}

/** The agent a `subagent` call is trying to start, if it names one. */
export function spawnTarget(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["agent", "agentName", "name", "type"]) {
    const v = input[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}
