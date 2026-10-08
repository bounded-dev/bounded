// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
import {
  type AgentName,
  type CallId,
  type DelegateEffectJSON,
  type Command,
  type DecisionId,
  dispatch,
  type Event,
  type Guard,
  type NamePattern,
  type ProjectPath,
  type ReadEffect,
  type Role,
  type SessionStart,
  type ToolKind,
  type ToolName,
  type ToolResultJSON,
  type ToolUse,
  type Url,
  Verdict,
  type WriteEffect,
} from "bounded/domain";

declare const toolUse: ToolUse;
declare const readEffect: ReadEffect;
declare const sessionGuards: Guard<SessionStart>[];
declare const contextGuards: Guard<ToolUse, { readonly protectedPaths: readonly string[] }>[];
declare const toolUseGuard: Guard<ToolUse>;
declare const pathsGuard: Guard<ToolUse, { readonly paths: readonly string[] }>;
declare const countGuard: Guard<ToolUse, { readonly paths: number }>;

// 1. A guard returns a Verdict built by Verdict: not a look-alike object, not a boolean, not a promise.
export const literal: Guard<ToolUse> = () => ({ kind: "allow" }); // rejected: is missing the following properties from type 'Allow': __brand
export const yes: Guard<ToolUse> = () => true; // rejected: Type 'boolean' is not assignable to type 'Verdict'
export const later: Guard<ToolUse> = async () => Verdict.allow; // rejected: Type 'Promise<Allow>' is not assignable to type 'Verdict'
export const noRedirect = Verdict.refuse("Generated file"); // rejected: Expected 2 arguments, but got 1
// 2. Events are built by parse, from the vocabulary only.
export const fake: ToolUse = { kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "read", path: "a.ts" as ProjectPath }] }; // rejected: is missing the following properties from type 'ReadEffect': __brand
export const fakeUse: ToolUse = { kind: "tool-use", role: null, toolKind: "edit", effects: [readEffect] }; // rejected: is missing the following properties from type 'ToolUse': __brand
export const plainResult: Verdict = { kind: "refuse", reason: "No", redirect: "Ask" }; // rejected: is missing the following properties from type 'Refuse': __brand
export const role: Role = "builder"; // rejected: is not assignable to type 'Role'
export const path: ProjectPath = "src/a.ts"; // rejected: is not assignable to type 'ProjectPath'
// Every value object is a class instance made by its parse: text never stands in for one.
export const command: Command = "ls"; // rejected: is not assignable to type 'Command'
export const url: Url = "https://example.com"; // rejected: is not assignable to type 'Url'
export const agent: AgentName = "explore"; // rejected: is not assignable to type 'AgentName'
export const tool: ToolName = "web_search"; // rejected: is not assignable to type 'ToolName'
export const filter: NamePattern = "*.ts"; // rejected: is not assignable to type 'NamePattern'
export const callId: CallId = "toolu_1"; // rejected: is not assignable to type 'CallId'
export const decisionId: DecisionId = "d-1"; // rejected: is not assignable to type 'DecisionId'
export const pathText: string = readEffect.path; // rejected: Type 'ProjectPath' is not assignable to type 'string'
export const product: ToolKind = "bash"; // rejected: Type '"bash"' is not assignable to type 'ToolKind'
// 3. A guard reads only what its event has: a session start has no effects, and each effect only its own fields.
export const startEffects: Guard<SessionStart> = (event) => (event.effects.length > 0 ? Verdict.allow : Verdict.allow); // rejected: Property 'effects' does not exist on type 'SessionStart'
export const readCommand: Guard<ToolUse> = (event) => (event.effects.some((effect) => effect.kind === "read" && effect.command.length > 0) ? Verdict.allow : Verdict.allow); // rejected: Property 'command' does not exist on type 'ReadEffect'
export const unnarrowed: Guard<ToolUse> = (event) => (event.effects[0].path === "a" ? Verdict.allow : Verdict.allow); // rejected: Property 'path' does not exist on type 'Effect'
export const noEffects: ToolUse["effects"] = []; // rejected: Source has 0 element(s) but target requires 1
export const badChange: WriteEffect["change"] = "rename"; // rejected: Type '"rename"' is not assignable to type 'Change'
// 4. Dispatch runs the guards of the event it is given, with the context they need.
export const wrongEvent = dispatch(sessionGuards, toolUse); // rejected: is not assignable to parameter of type 'SessionStart'
export const noContext = dispatch(contextGuards, toolUse); // rejected: Expected 3 arguments, but got 2
// 5. A guard serves only events it can read, and guards in one list agree on their context.
export const tooNarrow: Guard<Event>[] = [toolUseGuard]; // rejected: Type 'Guard<ToolUse>' is not assignable to type 'Guard<Event>'
export const widenedEvent = dispatch([toolUseGuard], toolUse as Event); // rejected: Argument of type 'Event' is not assignable to parameter of type 'ToolUse'
export const clashing = dispatch([pathsGuard, countGuard], toolUse, { paths: [] }); // rejected: is not assignable to type 'Guard<ToolUse
// A value object is made by its parse: even a complete look-alike lacks the brand only its class carries.
export const completePath: ProjectPath = { __brand: "ProjectPath", value: "a.ts", equals: () => true, toJSON: () => "a.ts" }; // rejected: Property '[projectPathBrand]' is missing
export const completeAllow: Verdict = { __brand: "Verdict", kind: "allow", equals: () => true, toJSON: () => ({ kind: "allow" }) }; // rejected: Property '[verdictBrand]' is missing
// 6. A delegation's flags and a run's finish are true or false, never text.
export const isolatedText: DelegateEffectJSON = { kind: "delegate", agent: "reviewer", isolated: "no" }; // rejected: Type 'string' is not assignable to type 'boolean'
export const finishedText: ToolResultJSON = { role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "a" }], ok: true, delegatedAgentRuns: [{ finished: "yes" }] }; // rejected: Type 'string' is not assignable to type 'boolean'
