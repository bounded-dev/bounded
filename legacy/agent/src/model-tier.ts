// Model-tier injection: the point where a seat's tier becomes the model that
// actually runs (issue #13, "Speed the seats").
//
// dev-stage-models.ts decides WHAT each seat should run on. This module is the
// trust boundary that makes it happen and records that it happened. Pure cores
// never log; the wiring layer does — the same split guard-log.ts,
// path-gate.ts and dev-tools.ts already follow.
//
// ── The mechanism, and why this one ──────────────────────────────────────
//
// Subagents are launched by the `subagent` tool from pi-subagents@0.52.1. Its
// top-level parameter schema (src/extension/schemas.ts) carries an optional
// `model`: "Default child model override. Full provider/id values are
// accepted." That value reaches
// `resolveEffectiveSubagentModel(params.model, agentConfig.model, parentModel,
// …)` (src/runs/foreground/subagent-executor.ts), where an explicit parameter
// beats agent frontmatter, which beats `subagents.agentOverrides`, which beats
// `subagents.defaultModel`, which beats the parent session's model. A `:high`
// style suffix on that string sets the child's thinking level
// (src/shared/model-info.ts, `splitKnownThinkingSuffix`). So one string on one
// parameter sets both halves of a tier.
//
// pi's `tool_call` extension hook makes `event.input` MUTABLE — "Mutate it in
// place to patch tool arguments before execution" (pi-coding-agent
// dist/core/extensions/types.d.ts). That is the whole mechanism: when a spawn
// names a pipeline role, put the tier's pattern on `input.model` before the
// tool runs.
//
// The alternatives were considered and rejected. Agent frontmatter `model:` is
// real and would work, but the values are per-project and the agent files are
// harness-global — one project's budget would become every project's. Settings
// `subagents.agentOverrides.<role>.model` has the same problem in the user
// settings file, and putting it in each project's `.pi/settings.json` means
// every project must know the harness's role names. The config file this reads
// keeps the role→tier mapping harness-owned and only the values per-project.
//
// ── The tier is policy, not a default ────────────────────────────────────
//
// When a tier IS configured for a seat, it beats a `model` the caller passed:
// seat models are harness-owned policy, and an architect that could hand its
// builder a different model per spawn would make the tier a suggestion — the
// exact prose-vs-mechanism failure this harness exists to close. The
// replacement is loud, not silent: the guard event records the discarded
// value, so a spawn that tried to choose is visible in the log. A caller's
// model stands only where the project set no tier for that seat.
//
// A model the live registry does not know is NOT injected. pi-subagents throws
// `Unknown subagent model '<x>'` on an unresolvable explicit model, which would
// turn a stale config line into a dead run — precisely the failure mode the
// config's never-fatal rule exists to prevent. When the registry snapshot is
// unavailable (empty), validation is skipped rather than assumed to fail: no
// snapshot is not evidence of a bad model.
//
// ── A CONTINUATION CANNOT BE TIERED ──────────────────────────────────────
//
// r15's kimi architect continued twelve finished workers. None of them
// produced a model-tier event, and the reason is not an oversight here: the
// host's continuation does not accept a model at all, and the worker keeps
// the model it was LAUNCHED on. Injecting a tier would not downtier the seat,
// it would kill the call. So a continued seat keeps the tier of its launch,
// and there is nothing to inject; a continuation logs a NOTE rather than
// nothing at all. Which call is a continuation is the host adapter's reading
// (CommissionHost in phase-gate.ts), so this file names no host's tool.
//
// ── What this cannot reach ───────────────────────────────────────────────
//
// * A multi-spawn form (a script or item array) names its children inside
//   itself, so the target role is not visible in the tool input. The top-level `model`
//   parameter IS forwarded to workflow children as their default, but with no
//   readable role there is no tier to choose, so those spawns are left alone.
// * A ROOT session that is itself a pipeline role — `pi` in a directory whose
//   `.bounded/dev-stage-role` says `architect`, which is how the dogfood harnessed
//   arm runs — was never spawned through this tool, so its model is whatever
//   the session was launched with. Only spawned seats are tiered.

import { logGuardEvent } from "./guard-log.ts";
import type { CommissionHost } from "./phase-gate.ts";
import {
  patternForTier,
  readDevStageModels,
  tierForAgent,
  TIER_KEY,
  type DevStageModels,
  type ModelTier,
  type TierKey,
} from "./dev-stage-models.ts";

/** The guard name every event from this module carries. */
export const MODEL_TIER_GUARD = "model-tier";

/** Enough of a registry model to check a pattern against. */
export interface KnownModel {
  readonly provider: string;
  readonly id: string;
}

/** What was decided for one `subagent` call. */
export type TierPlan =
  | {
      readonly kind: "inject";
      readonly role: string;
      readonly tier: ModelTier;
      readonly key: TierKey;
      /** The pi model pattern, thinking suffix included. */
      readonly model: string;
      /** A caller-passed model the tier replaced, when there was one. */
      readonly overrode?: string;
    }
  | { readonly kind: "skip"; readonly why: SkipReason; readonly note?: string };

export type SkipReason =
  /** Not a `subagent` launch that names an agent. */
  | "not-a-spawn"
  /** A spawn, but of scout / product-expert / delegate / anything unmapped. */
  | "not-a-pipeline-role"
  /** No config, or this tier unset in it — only then does a caller's model stand. */
  | "no-pattern"
  /** The pattern names no model the live registry knows. */
  | "unknown-model"
  /** A resume: the tool refuses a model override, so the child keeps its own. */
  | "untierable-resume";

const SKIP = (why: SkipReason, note?: string): TierPlan =>
  note === undefined ? { kind: "skip", why } : { kind: "skip", why, note };

/**
 * The agent a `subagent` call is trying to start, if it names one.
 *
 * Deliberately the same shape as the phase gate's spawn detection: only a
 * launch is a spawn, and the agent name may arrive under any of four keys. The
 * two live in different modules because they answer different questions (may
 * this spawn happen / what should it run on) and the phase gate is a frozen
 * enforcement surface; a drift test pins the key lists together.
 */
export const SPAWN_AGENT_KEYS: readonly string[] = ["agent", "agentName", "name", "type"];

/** The agent a launch names. Whether a call IS a launch is the host's reading
 *  (CommissionHost.classify); callers pass only launches. */
export function spawnTarget(input: Readonly<Record<string, unknown>>): string | undefined {
  return spawnAgentName(input);
}

/**
 * Does the live registry list this pattern? This is catalog membership only,
 * not deployment or credential validation. Use dogfood-reset --smoke-models
 * for an explicit live probe before a run.
 *
 * A deliberately small matcher: exact `provider/id`, or a bare id that exactly
 * one available model offers. pi-subagents matches far more loosely (separator
 * and case variants, trailing date stamps), so anything this accepts it
 * accepts too — the asymmetry costs a missed override on an exotic spelling,
 * never a thrown spawn. An empty snapshot means "cannot tell", which is
 * treated as known.
 */
export function patternIsKnown(pattern: string, known: readonly KnownModel[]): boolean {
  if (known.length === 0) return true; // no snapshot ⇒ no evidence ⇒ do not block
  const base = stripThinkingSuffix(pattern);
  if (known.some((m) => `${m.provider}/${m.id}` === base)) return true;
  return known.filter((m) => m.id === base).length === 1;
}

/** pi's thinking levels, as pi-subagents' `splitKnownThinkingSuffix` knows them. */
const THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** `provider/model:high` → `provider/model`. An unknown suffix is part of the id. */
export function stripThinkingSuffix(pattern: string): string {
  const colon = pattern.lastIndexOf(":");
  if (colon === -1) return pattern;
  return THINKING_LEVELS.includes(pattern.slice(colon + 1)) ? pattern.slice(0, colon) : pattern;
}

/**
 * Decide what one `subagent` call should run on. Pure.
 *
 * Every "no" is a named reason rather than a bare undefined, so the caller can
 * log the one case worth logging (a configured model the registry rejects)
 * and stay silent about the four that are ordinary.
 */
export function planModelTier(
  input: Readonly<Record<string, unknown>>,
  models: DevStageModels,
  known: readonly KnownModel[] = [],
): TierPlan {
  const role = spawnTarget(input);
  if (role === undefined) return SKIP("not-a-spawn");

  const tier = tierForAgent(role);
  if (tier === undefined) return SKIP("not-a-pipeline-role", role);

  const model = patternForTier(models, tier);
  if (model === undefined) return SKIP("no-pattern", TIER_KEY[tier]);

  if (!patternIsKnown(model, known)) return SKIP("unknown-model", model);

  // A configured tier is policy: it replaces a caller-passed model rather than
  // yielding to it, and the replacement is recorded so the attempt is visible.
  const existing = input["model"];
  if (typeof existing === "string" && existing.trim() !== "" && existing !== model) {
    return { kind: "inject", role, tier, key: TIER_KEY[tier], model, overrode: existing };
  }

  return { kind: "inject", role, tier, key: TIER_KEY[tier], model };
}

/**
 * A tier this project configured that the live registry cannot resolve.
 *
 * r15's first kimi reviewer ran on the session default because the configured
 * `kimi-k3:high` matched nothing in the registry: injection was skipped, the
 * spawn went ahead, and a judgment seat quietly ran on whatever the session
 * happened to be. Skipping is the wrong answer — the project stated what this
 * seat must run on, and running it on something else is a result produced by a
 * configuration nobody chose.
 *
 * Returns the facts; the refusal prose is the phase gate's, which is where
 * every other spawn refusal is written. `undefined` means there is nothing
 * wrong to report, which covers all four ordinary cases: not a pipeline role,
 * no tier configured for it, a resolvable pattern, and an EMPTY registry
 * snapshot — no snapshot is not evidence of a bad model, and the never-fatal
 * rule for absent or malformed config is untouched.
 */
export function unresolvableTier(
  role: string,
  models: DevStageModels,
  known: readonly KnownModel[],
): { readonly key: TierKey; readonly model: string } | undefined {
  const tier = tierForAgent(role);
  if (tier === undefined) return undefined;
  const model = patternForTier(models, tier);
  if (model === undefined) return undefined;
  if (patternIsKnown(model, known)) return undefined;
  return { key: TIER_KEY[tier], model };
}

/** The one-line summary a `model-tier` event carries. */
export function tierSummary(plan: Extract<TierPlan, { kind: "inject" }>): string {
  const base = `${plan.role} → ${plan.key} (${plan.model})`;
  return plan.overrode === undefined ? base : `${base} — replaced caller's '${plan.overrode}'`;
}

export interface ModelTierInput {
  readonly toolName: string;
  /** The tool's arguments. MUTATED in place when a tier applies. */
  readonly input: Record<string, unknown>;
  /** Target project root — the config is read from it, the event logged to it. */
  readonly cwd: string;
  /** Snapshot of the session's available models; empty when unavailable. */
  readonly known?: readonly KnownModel[];
}

// Warnings are per-process and per-project, not per-spawn: a malformed config
// is one mistake, and repeating it at every spawn buries the run's real output.
const warned = new Set<string>();

/** Test-only: forget which warnings this process has already emitted. */
export function resetModelTierWarnings(): void {
  warned.clear();
}

/**
 * Apply the project's tier to a `subagent` spawn, in place, and record it.
 *
 * Returns the plan so the caller (and the tests) can see what was decided.
 * Never throws: a failure here must cost a run its speed, never its life.
 */
export function applyModelTier(ev: ModelTierInput, host: CommissionHost): TierPlan {
  if (ev.toolName !== "subagent") return SKIP("not-a-spawn");
  // A resume is a commissioned seat that this module can do nothing for: the
  // tool refuses a model override outright and the child reuses its persisted
  // one (see "A RESUME CANNOT BE TIERED" in the header). Say so in the log.
  // r15 made twelve of these and left no trace of any of them.
  const call = host.classify(ev.input);
  if (call.kind === "continue") {
    noteUntierableResume(ev.cwd, call.run, call.role);
    return SKIP("untierable-resume", call.run ?? "unnamed run");
  }
  if (call.kind !== "launch" || spawnTarget(ev.input) === undefined) return SKIP("not-a-spawn");

  const models = readDevStageModels(ev.cwd);
  reportWarnings(ev.cwd, models.warnings);

  const plan = planModelTier(ev.input, models, ev.known ?? []);

  if (plan.kind === "skip") {
    // Four of the five skips are ordinary and stay silent. A configured model
    // the registry does not know is a config error the run should be able to
    // see, so it is logged and warned exactly once.
    if (plan.why === "unknown-model") {
      reportWarnings(ev.cwd, [
        `model-tier: model "${plan.note}" is not in this session's model registry — ` +
          "no tier can be applied (a spawn carrying it would have failed outright), and a " +
          "pipeline seat with a configured tier is refused rather than run on the wrong model",
      ]);
    }
    return plan;
  }

  ev.input["model"] = plan.model;
  logGuardEvent(ev.cwd, {
    guard: MODEL_TIER_GUARD,
    verdict: "pass",
    summary: tierSummary(plan),
    detail:
      plan.overrode === undefined
        ? { role: plan.role, tier: plan.tier, key: plan.key, model: plan.model }
        : { role: plan.role, tier: plan.tier, key: plan.key, model: plan.model, overrode: plan.overrode },
  });
  return plan;
}

/**
 * One `model-tier` line per resume, saying the seat was not tiered and why.
 *
 * A pass, not an error: the child keeps the model it was launched with, which
 * is the right model whenever the launch itself was tiered. What would be
 * wrong is silence — a resumed seat that appears nowhere is a seat no reader
 * can account for, and r15 had twelve of them.
 *
 * Per call rather than once per project: each resume is a seat put back to
 * work, and the log is the run's story of who was working when.
 */
function noteUntierableResume(cwd: string, named: string | undefined, role: string | undefined): void {
  const run = named ?? "unnamed run";
  logGuardEvent(cwd, {
    guard: MODEL_TIER_GUARD,
    verdict: "pass",
    summary: `resume of ${role ?? "unknown"} (${run}) is untierable — the child keeps its launch model`,
    detail: {
      kind: "untierable-resume",
      run,
      role: role ?? "unknown",
      why: "a continuation keeps the model the worker was launched on and accepts no model override",
    },
  });
}

/** The agent name a call NAMES, whatever its action. `spawnTarget` answers the
 *  narrower question (is this a launch of one), and a resume is not. */
export function spawnAgentName(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of SPAWN_AGENT_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

/** One stderr line and one guard event per distinct warning, per project. */
function reportWarnings(cwd: string, warnings: readonly string[]): void {
  for (const warning of warnings) {
    if (warned.has(`${cwd} ${warning}`)) continue;
    warned.add(`${cwd} ${warning}`);
    console.warn(`[model-tier] ${warning}`);
    logGuardEvent(cwd, {
      guard: MODEL_TIER_GUARD,
      verdict: "error",
      summary: warning,
      detail: { kind: "config-ignored" },
    });
  }
}
