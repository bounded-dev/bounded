// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
import { dispatch, type Event, type Guard, type ProjectPath, type Role, type SessionStart, type ToolKind, type ToolUse, Verdict, type WriteEffect } from "bounded/domain";

declare const toolUse: ToolUse;
declare const sessionGuards: Guard<SessionStart>[];
declare const contextGuards: Guard<ToolUse, { readonly protectedPaths: readonly string[] }>[];
declare const toolUseGuard: Guard<ToolUse>;
declare const pathsGuard: Guard<ToolUse, { readonly paths: readonly string[] }>;
declare const countGuard: Guard<ToolUse, { readonly paths: number }>;

// 1. A guard returns a Verdict built by Verdict: not a look-alike object, not a boolean, not a promise.
export const literal: Guard<ToolUse> = () => ({ kind: "allow" }); // rejected: Property '__brand' is missing
export const yes: Guard<ToolUse> = () => true; // rejected: Type 'boolean' is not assignable to type 'Verdict'
export const later: Guard<ToolUse> = async () => Verdict.allow; // rejected: Type 'Promise<Allow>' is not assignable to type 'Verdict'
export const noRedirect = Verdict.refuse("Generated file"); // rejected: Expected 2 arguments, but got 1
// 2. Events are built by parse, from the vocabulary only.
export const fake: ToolUse = { kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "read", path: "a.ts" as ProjectPath }] }; // rejected: Property '__brand' is missing
export const role: Role = "builder"; // rejected: is not assignable to type 'Role'
export const path: ProjectPath = "src/a.ts"; // rejected: is not assignable to type 'ProjectPath'
export const product: ToolKind = "bash"; // rejected: Type '"bash"' is not assignable to type 'ToolKind'
// 3. A guard reads only what its event has: a session start has no effects, and each effect only its own fields.
export const startEffects: Guard<SessionStart> = (event) => (event.effects.length > 0 ? Verdict.allow : Verdict.allow); // rejected: Property 'effects' does not exist on type 'SessionStart'
export const readCommand: Guard<ToolUse> = (event) => (event.effects.some((effect) => effect.kind === "read" && effect.command.length > 0) ? Verdict.allow : Verdict.allow); // rejected: Property 'command' does not exist on type 'ReadEffect'
export const unnarrowed: Guard<ToolUse> = (event) => (event.effects[0].path === "a" ? Verdict.allow : Verdict.allow); // rejected: Property 'path' does not exist on type 'ExecuteEffect'
export const noEffects: ToolUse["effects"] = []; // rejected: Source has 0 element(s) but target requires 1
export const badChange: WriteEffect["change"] = "rename"; // rejected: Type '"rename"' is not assignable to type 'Change'
// 4. Dispatch runs the guards of the event it is given, with the context they need.
export const wrongEvent = dispatch(sessionGuards, toolUse); // rejected: is not assignable to parameter of type 'SessionStart'
export const noContext = dispatch(contextGuards, toolUse); // rejected: Expected 3 arguments, but got 2
// 5. A guard serves only events it can read, and guards in one list agree on their context.
export const tooNarrow: Guard<Event>[] = [toolUseGuard]; // rejected: Type 'Guard<ToolUse>' is not assignable to type 'Guard<Event>'
export const widenedEvent = dispatch([toolUseGuard], toolUse as Event); // rejected: Argument of type 'Event' is not assignable to parameter of type 'ToolUse'
export const clashing = dispatch([pathsGuard, countGuard], toolUse, { paths: [] }); // rejected: is not assignable to type 'Guard<ToolUse
