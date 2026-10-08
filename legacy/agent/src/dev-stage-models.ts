// Two model tiers for the developer-stage pipeline (issue #13, "Speed the seats").
//
// The pipeline has four seats and they are not the same kind of work. The
// ARCHITECT and the REVIEWER make judgments — what the interface should be,
// what the spec must pin, whether the design holds. Runs 10–12 showed design
// quality tracks the model, so those two are where thinking is worth buying.
// The TEST-WRITER and the BUILDER produce against a frozen contract and a
// written spec: the judgment has already been made, and their output is
// volume. Paying design prices for volume is how a 35-minute run happens.
//
// So: two named parameters, not four.
//
//   designModel  → architect, reviewer      (the judgment seats)
//   workerModel  → test-writer, builder     (the production seats)
//
// pi's model pattern carries the thinking level as a suffix
// (`provider/model:<level>`, levels off|minimal|low|medium|high|xhigh|max —
// see pi-subagents' `splitKnownThinkingSuffix`), so ONE string sets both the
// model and how hard it thinks. That is why this is two parameters and not
// four: the tier is the whole setting.
//
// ── What is harness-owned and what is per-project ────────────────────────
//
// The role→tier MAPPING is harness-owned: it is a statement about what each
// seat does, which does not vary by project. `TIER_BY_ROLE` below is that
// statement, and a drift test pins its keys to the path policy's roster so a
// fifth seat cannot be added without deciding which tier it belongs to.
//
// The VALUES are per-project, because which model is worth its price depends
// on the codebase, the budget, and what the provider offers this week. They
// live in `<project>/.bounded/dev-stage-models.json`, next to `.bounded/dev-stage-role`
// and the guard log — the same per-project `.bounded/` directory every other piece
// of run state already uses.
//
//   { "designModel": "anthropic/claude-opus-4:high",
//     "workerModel": "fireworks/kimi-k3-fast:medium" }
//
// ── Never fatal ──────────────────────────────────────────────────────────
//
// A missing file, a missing key, an unreadable file, a malformed one: all mean
// "no override" — the seat runs on the session default, exactly as it did
// before this file existed. A config that cannot be parsed produces warnings
// and is ignored. This is deliberate and it is the one hard rule here: a
// broken speed knob must never cost a run. Everything a gate refuses is
// refused because proceeding would produce a WRONG result; running the builder
// on the session default instead of the configured tier produces a right
// result more slowly, which is not a reason to stop.
//
// That is also why unknown keys warn rather than being ignored silently: the
// realistic failure is `designmodel` or `design_model`, which would otherwise
// do nothing at all with no way to notice.
//
// This module is pure apart from `readDevStageModels`, which is a thin
// never-throwing file read. The spawn-time injection and the guard-log
// boundary live in model-tier.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "./path-policy.ts";

/** Where a project states its tier values, relative to the project root. */
export const DEV_STAGE_MODELS_RELATIVE = ".bounded/dev-stage-models.json";

/** The two tiers: judgment and production. */
export type ModelTier = "design" | "worker";

/** The config key each tier is read from. Also what the guard event reports. */
export const TIER_KEY = {
  design: "designModel",
  worker: "workerModel",
} as const satisfies Record<ModelTier, string>;

export type TierKey = (typeof TIER_KEY)[ModelTier];

/**
 * Which seat draws on which tier. Harness-owned (see the header).
 *
 * Keyed by `Role` so adding a pipeline role to the path policy without
 * assigning it a tier is a type error, not a silently untiered seat.
 */
export const TIER_BY_ROLE: Record<Role, ModelTier> = {
  architect: "design",
  reviewer: "design",
  "test-writer": "worker",
  builder: "worker",
};

/** The tier for an untrusted agent name, or undefined for anything else. */
export function tierForAgent(agent: unknown): ModelTier | undefined {
  if (typeof agent !== "string") return undefined;
  return Object.prototype.hasOwnProperty.call(TIER_BY_ROLE, agent)
    ? TIER_BY_ROLE[agent as Role]
    : undefined;
}

/**
 * A project's tier values.
 *
 * Both patterns are optional and independent: a project may set one tier and
 * leave the other on the session default. `warnings` is the diagnosis of
 * anything that was ignored — empty on a clean read AND on an absent file,
 * because absence is the normal case, not a problem.
 */
export interface DevStageModels {
  /** The `designModel` pattern, when the project set a usable one. */
  readonly design?: string;
  /** The `workerModel` pattern, when the project set a usable one. */
  readonly worker?: string;
  /** Everything ignored and why. Never throws instead of one of these. */
  readonly warnings: readonly string[];
}

/** No config at all: the session default governs every seat. */
export const NO_DEV_STAGE_MODELS: DevStageModels = { warnings: [] };

const KEYS: readonly TierKey[] = ["designModel", "workerModel"];

/**
 * A model pattern is one non-blank token. Surrounding whitespace is trimmed
 * (a stray space is not a mistake worth punishing); whitespace INSIDE it means
 * a typo — no pi model id contains a space — and is rejected rather than sent
 * to the registry to fail there.
 */
function usablePattern(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed !== "" && !/\s/.test(trimmed) ? trimmed : undefined;
}

/**
 * Parse the config text. Pure, total, and never throws.
 *
 * Every rejection path yields `{ warnings }` with the tiers it could still
 * read intact — one bad key does not discard the other.
 */
export function parseDevStageModels(raw: string): DevStageModels {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { warnings: [`${DEV_STAGE_MODELS_RELATIVE} is not valid JSON (${detail}) — ignored`] };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      warnings: [
        `${DEV_STAGE_MODELS_RELATIVE} must be a JSON object with "designModel" / "workerModel" — ignored`,
      ],
    };
  }

  const record = parsed as Record<string, unknown>;
  const warnings: string[] = [];
  const models: { design?: string; worker?: string } = {};

  for (const key of Object.keys(record)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      warnings.push(
        `${DEV_STAGE_MODELS_RELATIVE}: unknown key "${key}" — the keys are ${KEYS.join(" and ")}`,
      );
    }
  }

  for (const tier of ["design", "worker"] as const) {
    const key = TIER_KEY[tier];
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue; // absent ⇒ session default
    const value = record[key];
    const pattern = usablePattern(value);
    if (pattern !== undefined) {
      models[tier] = pattern;
    } else {
      warnings.push(
        `${DEV_STAGE_MODELS_RELATIVE}: "${key}" must be a pi model pattern like ` +
          `"provider/model:high" — ignored (got ${JSON.stringify(value)})`,
      );
    }
  }

  return { ...models, warnings };
}

/** Absolute path to a project's tier config. */
export function devStageModelsPath(cwd: string): string {
  return join(cwd, DEV_STAGE_MODELS_RELATIVE);
}

/**
 * Read a project's tier config. Absent ⇒ no override, no warning.
 *
 * The only I/O in this module, and it cannot throw: an unreadable file is
 * indistinguishable from an absent one as far as the pipeline is concerned,
 * because both mean the seats run on the session default.
 */
export function readDevStageModels(cwd: string): DevStageModels {
  let raw: string;
  try {
    raw = readFileSync(devStageModelsPath(cwd), "utf8");
  } catch {
    return NO_DEV_STAGE_MODELS; // absent or unreadable ⇒ session default
  }
  return parseDevStageModels(raw);
}

/** The pattern configured for a tier, or undefined when that tier is unset. */
export function patternForTier(models: DevStageModels, tier: ModelTier): string | undefined {
  return tier === "design" ? models.design : models.worker;
}
