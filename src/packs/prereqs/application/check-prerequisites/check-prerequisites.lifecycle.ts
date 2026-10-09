import type { AfterTool, BeforeTool, Effect, LifecycleContext } from "bounded/domain";
import { Verdict } from "bounded/domain";
import { rulesIn } from "../../domain/prerequisite-rule.ts";
import { fileSetFingerprintsPort, prerequisiteRecordsPort } from "./check-prerequisites.contract.ts";
import { CheckPrerequisitesHandler } from "./check-prerequisites.handler.ts";

// The check-prerequisites feature as the core's lifecycle checks: they read
// the host's adapters from the context's ports, and map the feature's in
// port to what the core runs and records.

const PREFIX = "bounded/prereqs.rules:";
const NO_PORTS = "Open the project with bounded/prereqs's ports (prereqsPortProvisions()); until then actions that need a prerequisite are refused";

/** The feature for this project, or why its ports cannot be had. */
function handler({ composition, ports }: LifecycleContext): CheckPrerequisitesHandler | string {
  const fingerprints = ports.get(fileSetFingerprintsPort);
  if (!fingerprints.ok) return fingerprints.error;
  const records = ports.get(prerequisiteRecordsPort);
  if (!records.ok) return records.error;
  return new CheckPrerequisitesHandler(composition, fingerprints.value, records.value);
}

/** Whether any rule concerns these effects, so a missing port matters; rules that cannot be read concern everything, failing closed. */
function concerns({ composition }: LifecycleContext, effects: readonly Effect[]): boolean {
  const point = rulesIn(composition);
  if (point === undefined) return false;
  const rules = composition.entries(point);
  if (!rules.ok) return true;
  return rules.value.some(({ value: rule }) => effects.some((effect) => rule.comesBefore(effect) || (effect.kind === "delegate" && rule.requiresDelegationTo(effect.agent))));
}

/** Before a tool call runs: refuse an action whose prerequisite does not hold, and keep the start of a delegation some rule requires. */
export const checkBeforeTool: BeforeTool = async (call, context) => {
  const check = handler(context);
  if (typeof check !== "string") return check.before(call);
  if (!concerns(context, call.effects)) return Verdict.allow;
  return Verdict.refuse(`${PREFIX} prerequisites cannot be checked: ${check}`, NO_PORTS);
};

/** After a tool call ran: record a delegation some rule requires that finished and succeeded over unchanged files, or say why not. */
export const recordAfterTool: AfterTool = async (result, context) => {
  const check = handler(context);
  if (typeof check !== "string") return check.after(result);
  if (!concerns(context, result.effects)) return { message: null, record: null };
  const message = `${PREFIX} prerequisites cannot be recorded after this call: ${check}`;
  const effect = result.effects.find((given) => given.kind === "delegate") ?? null;
  return { message, record: { verdict: Verdict.refuse(message, NO_PORTS), refusedBy: { effect }, note: "a prerequisite could not be recorded" } };
};
