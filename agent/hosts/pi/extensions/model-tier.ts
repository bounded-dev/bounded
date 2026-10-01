/**
 * Model-tier extension (issue #13, "Speed the seats").
 *
 * A `tool_call` hook that patches the `model` argument of a `subagent` spawn
 * so each pipeline seat runs on its project's tier: architect and reviewer on
 * `designModel`, test-writer and builder on `workerModel`. Every other agent —
 * scout, product-expert, delegate, anything unmapped — is untouched, and so is
 * every session whose project has no `.bounded/dev-stage-models.json`.
 *
 * All of the decision lives in ../src/model-tier.ts (which is testable without
 * pi) and ../src/dev-stage-models.ts (the config reader). This file is the
 * pi-facing wiring and nothing else.
 *
 * ── Why a hook of its own ────────────────────────────────────────────────
 *
 * The path gate already intercepts `subagent` calls, but only for a session
 * that HOLDS a pipeline role, because that is what it gates. Tiering has to
 * work one level up as well: whoever launches the architect — an orchestrator,
 * a team lead, a plain session — holds no role, so the path gate's hook is
 * inactive there and would never see the spawn. This hook is unconditional
 * instead, and decides purely from the spawn's target.
 *
 * Both hooks may fire on the same call. Order does not matter: this one only
 * mutates arguments and never blocks, and pi's contract is that later
 * `tool_call` handlers see earlier mutations. A spawn the phase gate goes on
 * to refuse leaves a `model-tier` pass followed by a `phase-gate` block, which
 * reads correctly — the tier was chosen, the spawn was not allowed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyModelTier, type KnownModel } from "../../../src/model-tier.ts";
import { PI_COMMISSIONS } from "./lib/commissions.ts";

/**
 * The session's available models, as bare `{provider, id}` pairs.
 *
 * Two callers, one snapshot: this hook, which declines to inject a model the
 * registry cannot resolve (an explicit unknown model makes pi-subagents throw,
 * which would let a stale config line kill a run), and the path gate, which
 * REFUSES the spawn on the same evidence rather than letting the seat run
 * untiered. A registry that cannot be read yields an empty snapshot, which
 * both treat as "cannot tell" rather than "bad".
 */
export function knownModels(ctx: {
  modelRegistry?: { getAvailable(): { provider: string; id: string }[] };
}): readonly KnownModel[] {
  try {
    return (
      ctx.modelRegistry?.getAvailable().map((m) => ({ provider: m.provider, id: m.id })) ?? []
    );
  } catch {
    return [];
  }
}

export function installModelTier(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return undefined;
    applyModelTier({
      toolName: event.toolName,
      input: event.input as Record<string, unknown>,
      cwd: ctx.cwd,
      known: knownModels(ctx),
    }, PI_COMMISSIONS);
    return undefined; // never blocks: tiering is a speed decision, not a gate
  });
}

export default function (pi: ExtensionAPI): void {
  installModelTier(pi);
}
