// The legitimate forms of events, verdicts and guards. Compiles without errors.
import { type AgentRunFinishedJSON, type AgentRunFinishReport, contribution, corePack, type DelegatedAgentRunJSON, type DelegateEffectJSON, definePack, dispatch, type Event, type ExecuteEffectJSON, type Guard, type SessionStart, type ShellCommandReadingJSON, type ToolResultJSON, type ToolUse, Verdict } from "bounded/domain";
import { packId } from "./packs.ts";

declare const toolUse: ToolUse;
declare const start: SessionStart;

// A guard returns a verdict built by Verdict, and narrows each effect by its kind.
export const noGenerated: Guard<ToolUse> = (event) =>
  event.effects.some((effect) => effect.kind === "write" && effect.path.value.startsWith("generated/"))
    ? Verdict.refuse("Generated file", "Change the generator's input instead")
    : Verdict.allow;
// An execute's command, a list's root and filter are value objects: their text is their value.
export const noForce: Guard<ToolUse> = (event) =>
  event.effects.some((effect) => effect.kind === "execute" && effect.command.value.includes("--force")) ? Verdict.refuse("Forced", "Run it without --force") : Verdict.allow;
export const wholeProject: Guard<ToolUse> = (event) =>
  event.effects.some((effect) => effect.kind === "list" && effect.root.value === "." && effect.filter === null) ? Verdict.refuse("Lists the whole project", "List a directory") : Verdict.allow;
// A guard for any event serves for tool uses and session starts alike.
export const anyEvent: Guard<Event> = (event) => (event.role === null ? Verdict.refuse("No role", "Start as a role") : Verdict.allow);
export const verdicts: Verdict[] = [dispatch([noGenerated, noForce, wholeProject, anyEvent], toolUse), dispatch([anyEvent], start), dispatch([], toolUse)];
// The context is a placeholder the integration fills; a guard that takes one is given one.
export const withContext: Guard<ToolUse, { readonly protectedPaths: readonly string[] }> = (event, context) =>
  event.effects.some((effect) => effect.kind === "write" && context.protectedPaths.includes(effect.path.value)) ? Verdict.refuse("Protected", "Ask the owner") : Verdict.allow;
export const contextual: Verdict = dispatch([withContext], toolUse, { protectedPaths: [".git"] });
// A guard that needs no context sits in a list with guards that do: every guard is given it.
export const mixed: Verdict = dispatch([noGenerated, withContext], toolUse, { protectedPaths: [".git"] });
// A delegation says on the call whether it is isolated and whether its finish goes unreported; a result says, per delegate effect, whether its run finished.
export const flagged: DelegateEffectJSON = { kind: "delegate", agent: "reviewer", isolated: true, finishUnreported: true };
export const finished: ToolResultJSON = { role: null, tool: "subagent", effects: [flagged], ok: true, delegatedAgentRuns: [{ finished: true }] };
// An execute carries bounded's reading of its command, required: the programs it runs, the files it reads, lists and writes, and what could not be resolved.
export const reading: ShellCommandReadingJSON = {
  outcome: "read",
  programs: [{ name: { kind: "literal", text: "cat" }, arguments: [{ kind: "unresolved", text: "$X" }], workingDirectory: "." }],
  fileEffects: [{ effect: { kind: "read", path: ".env" } }, { effect: { kind: "write", path: "out.txt", change: "create" }, existenceUnknown: true }],
  unresolved: [{ text: "$X", role: "read" }],
};
export const unread: ShellCommandReadingJSON = { outcome: "unread", why: "the parser could not load" };
export const executed: ExecuteEffectJSON = { kind: "execute", command: "cat .env $X", reading };
// Guards read a reading's programs once its outcome says it was read.
export const programsRead: Guard<ToolUse> = (event) =>
  event.effects.some((effect) => effect.kind === "execute" && effect.reading.outcome === "read" && effect.reading.programs.some((program) => program.name.text === "terraform"))
    ? Verdict.refuse("Runs terraform", "Ask the platform team")
    : Verdict.allow;
// An agent run's finish names the session's role, the agent the host ran, the run's id, and whether it ran to its end (null: the host does not say).
export const agentRunFinished: AgentRunFinishedJSON = { kind: "agent-run-finished", role: null, agent: "plan-reviewer", agentRunId: "a6eef1505a0b443a2", ranToEnd: null };
// A result's entry may name its run, the agent the host ran, and say the run's finish is reported later.
export const launchedRun: DelegatedAgentRunJSON = { finished: false, agentRunId: "a1", finishReportedLater: true };
export const completedRun: DelegatedAgentRunJSON = { finished: true, agentRunId: "a1", resolvedAgent: "plan-reviewer" };
export const launched: ToolResultJSON = { role: null, tool: "subagent", effects: [flagged], ok: true, delegatedAgentRuns: [launchedRun] };
// A pack observes a run's finish through the core's onAgentRunFinish point, reporting a record or none.
const recorded: AgentRunFinishReport = { record: { verdict: Verdict.allow, note: "recorded" } };
export const finishWatcher = definePack({
  id: packId("finish-watcher"),
  dependsOn: [corePack],
  contributes: [contribution(corePack.points.onAgentRunFinish, [async (finish) => (finish.ranToEnd === false ? { record: null } : recorded)])],
});
