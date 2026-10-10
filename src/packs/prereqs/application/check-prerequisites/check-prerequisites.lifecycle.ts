import type { AfterTool, AgentRunFinishHandler, BeforeTool, Effect, LifecycleContext } from "bounded/domain";
import { Verdict } from "bounded/domain";
import type { PrerequisiteRule } from "../../domain/prerequisite-rule.contract.ts";
import { rulesIn } from "../../domain/prerequisite-rule.ts";
import { fileSetFingerprintsPort, prerequisiteRecordsPort, prerequisiteStatusSnapshotsPort } from "./check-prerequisites.contract.ts";
import { CheckPrerequisitesHandler } from "./check-prerequisites.handler.ts";

// The check-prerequisites feature as the core's lifecycle checks: they read
// the host's adapters from the context's ports, and map the feature's in
// port to what the core runs and records.

const PREFIX = "bounded/prereqs.rules:";
const NO_PORTS = "Open the project with bounded/prereqs's ports (prereqsPortProvisions()); until then actions that need a prerequisite are refused";
/** How long reading the status for its snapshot may take: with the save's 500 ms, at most 2.5 s per call or finish (ADR 2026-026). */
const STATUS_WITHIN_MS = 2000;

/** The feature for this project, or why its ports cannot be had. */
function handler({ composition, ports }: LifecycleContext): CheckPrerequisitesHandler | string {
  const fingerprints = ports.get(fileSetFingerprintsPort);
  if (!fingerprints.ok) return fingerprints.error;
  const records = ports.get(prerequisiteRecordsPort);
  if (!records.ok) return records.error;
  return new CheckPrerequisitesHandler(composition, fingerprints.value, records.value);
}

/**
 * Whether any rule concerns these effects, so a missing port matters; rules
 * that cannot be read concern everything, failing closed. Before a call, an
 * action a rule comes before, or may (a command it cannot see through, so it
 * is refused rather than allowed), and a delegation it may need; after one,
 * only a delegation: no other result records anything.
 */
function concerns({ composition }: LifecycleContext, effects: readonly Effect[], moment: "before" | "after"): boolean {
  const point = rulesIn(composition);
  if (point === undefined) return false;
  const rules = composition.entries(point);
  if (!rules.ok) return true;
  const gates = (rule: PrerequisiteRule, effect: Effect): boolean => {
    if (effect.kind === "delegate" && (rule.comesBefore(effect) || rule.mayResolveToRequiredAgent(effect.agent))) return true;
    return moment === "before" && rule.matchBefore(effect).kind !== "not-before";
  };
  return rules.value.some(({ value: rule }) => effects.some((effect) => gates(rule, effect)));
}

/** Before a tool call runs: refuse an action whose prerequisite does not hold, and keep the start of a delegation some rule requires. */
export const checkBeforeTool: BeforeTool = async (call, context) => {
  const check = handler(context);
  if (typeof check !== "string") return check.before(call);
  if (!concerns(context, call.effects, "before")) return Verdict.allow;
  return Verdict.refuse(`${PREFIX} prerequisites cannot be checked: ${check}`, NO_PORTS);
};

/** After a tool call ran: record a delegation some rule requires that finished and succeeded over unchanged files, or say why not. */
export const recordAfterTool: AfterTool = async (result, context) => {
  const check = handler(context);
  if (typeof check !== "string") return check.after(result);
  if (!concerns(context, result.effects, "after")) return { message: null, record: null };
  const message = `${PREFIX} prerequisites cannot be recorded after this call: ${check}`;
  const effect = result.effects.find((given) => given.kind === "delegate") ?? null;
  return { message, record: { verdict: Verdict.refuse(message, NO_PORTS), refusedBy: { effect }, note: "a prerequisite could not be recorded" } };
};

/** When a run whose finish the host reports later has finished: record it if it meets a requirement over unchanged files, or record why not (ADR 2026-025). */
export const recordRunAtFinish: AgentRunFinishHandler = async (finish, context) => {
  const check = handler(context);
  if (typeof check !== "string") return check.recordAgentRunFinish(finish);
  if (rulesIn(context.composition) === undefined) return { record: null };
  const reason = `${PREFIX} the finish of ${finish.agent.value}'s run ${finish.agentRunId.value} cannot be recorded: ${check}`;
  return { record: { verdict: Verdict.refuse(reason, NO_PORTS), note: "a prerequisite could not be recorded" } };
};

/**
 * Saves the status snapshot when the host provides its optional port (ADR
 * 2026-026), and does nothing when it does not. For display only: it never
 * refuses, records nothing, and ends within its bounds. When the pack's own
 * ports are missing, the snapshot is unread, naming them.
 */
async function writeStatus(context: LifecycleContext): Promise<void> {
  try {
    const snapshots = context.ports.ifProvided(prerequisiteStatusSnapshotsPort);
    if (snapshots === undefined || !snapshots.ok) return;
    const check = handler(context);
    if (typeof check === "string") {
      await CheckPrerequisitesHandler.writeUnreadStatusSnapshot(snapshots.value, `${PREFIX} prerequisites cannot be read: ${check}`, { withinMs: STATUS_WITHIN_MS });
      return;
    }
    await check.writeStatusSnapshot(snapshots.value, { withinMs: STATUS_WITHIN_MS });
  } catch {
    // For display only: nothing here may change what the call or the finish comes to.
  }
}

/** After a tool call, once its records are made: save the status snapshot, telling and recording nothing. */
export const writeStatusAfterTool: AfterTool = async (_result, context) => {
  await writeStatus(context);
  return { message: null, record: null };
};

/** After an agent run's finish, once it is recorded: save the status snapshot, recording nothing. */
export const writeStatusAtFinish: AgentRunFinishHandler = async (_finish, context) => {
  await writeStatus(context);
  return { record: null };
};
