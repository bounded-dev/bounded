// The legitimate forms of events, verdicts and guards. Compiles without errors.
import { dispatch, type Event, type Guard, type SessionStart, type ToolUse, Verdict } from "bounded/domain";

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
