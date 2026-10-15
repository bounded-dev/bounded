import type { exampleScenariosBrand } from "./example-scenarios.contract.ts";
import type { CommandToRead } from "../events/effect.contract.ts";
import { commandToReadOf, describeEffect, describeExecute, Effect } from "../events/effect.ts";
import { ProjectPath } from "../events/project-path.ts";
import type { DelegatedAgentRun } from "../events/tool-result.contract.ts";
import { delegatedAgentRunJSON, delegatedAgentRunsOf, TOOL_RESULT_SAYS_OK } from "../events/tool-result.ts";
import { type Call, callOf } from "../events/tool-use.ts";
import { own, readSafely } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import { Verdict } from "../verdicts/verdict.ts";
import type * as Contract from "./example-scenarios.contract.ts";

// An example's scenarios (ADR 2026-031). Each part of a step is checked by
// the parser that owns it, keeping its message: a call's role, tool kind,
// effects and call id by callOf, as a tool use's; every effect but an
// execute by Effect.parse; an execute effect's command and cwd by
// commandToReadOf, as an execute effect's; a verdict by Verdict.parse; a
// tool result's ok and delegated runs as a tool result's.

const FORM = "Example scenarios are { scenarios }: a list of at least one scenario, each { title, projectFiles?, steps }";
const SCENARIO_FORM = "{ title, projectFiles?, steps }";
const STEP_KINDS = "a step is one of { toolUse, verdict }, { toolResult, afterToolMessage } or { changeFiles }";
const TOOL_USE_FORM = "{ role?, tool, effects, callId? }";
const TOOL_RESULT_FORM = "{ role?, tool, effects, ok, callId?, delegatedAgentRuns? }";
const EXECUTE_FORM = "a scenario's execute effect is { kind, command, cwd? }";
const LEAVE_THE_READING_OUT = "a scenario's execute effect is a command bounded reads when the scenario runs: leave its reading out";
const OWNED = "is where Bounded keeps its own files (the project's bounded.config.* at its root, .bounded/): a scenario writes no file there";
/** The first path segment, ignoring case, under which a scenario writes nothing: Bounded's own state. Where a runner installs packages is the runner's concern, never the domain's. */
const BOUNDED_STATE_DIRECTORY = ".bounded";
/** The start of the project's configuration's name at its root, ignoring case: bounded.config.ts and every other name it may have. */
const CONFIGURATION_NAME = "bounded.config.";

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isRecord = (raw: unknown): raw is object => typeof raw === "object" && raw !== null && !Array.isArray(raw);
/** The first key of `raw` that is not one of `allowed`, or undefined. */
const unknownKey = (raw: object, allowed: readonly string[]): string | undefined => Object.keys(raw).find((key) => !allowed.includes(key));

/** An effect in a scenario: an effect, or an execute effect's command still to be read. */
type ScenarioEffect = { readonly kind: "effect"; readonly effect: Effect } | { readonly kind: "command"; readonly toRead: CommandToRead };

type Step =
  | { readonly kind: "toolUse"; readonly call: Call<ScenarioEffect>; readonly verdict: Verdict }
  | { readonly kind: "toolResult"; readonly call: Call<ScenarioEffect>; readonly ok: boolean; readonly runs: readonly DelegatedAgentRun[] | undefined; readonly afterToolMessage: string | null }
  | { readonly kind: "changeFiles"; readonly changes: readonly { readonly path: ProjectPath; readonly text: string | null }[] };

interface Scenario {
  readonly title: string;
  readonly projectFiles: readonly { readonly path: ProjectPath; readonly text: string }[];
  readonly steps: readonly Step[];
}

/** An effect of a scenario's call: an execute effect is exactly { kind, command, cwd? }, never with a reading; any other is an effect. */
function scenarioEffectOf(raw: unknown): Result<ScenarioEffect> {
  if (!isRecord(raw) || own(raw, "kind") !== "execute") {
    const effect = Effect.parse(raw);
    return effect.ok ? { ok: true, value: Object.freeze({ kind: "effect", effect: effect.value }) } : effect;
  }
  if (Object.hasOwn(raw, "reading")) return refuse(LEAVE_THE_READING_OUT);
  const extra = unknownKey(raw, ["kind", "command", "cwd"]);
  if (extra !== undefined) return refuse(`${EXECUTE_FORM}, with no field '${extra}'`);
  const toRead = commandToReadOf(own(raw, "command"), own(raw, "cwd"));
  return toRead.ok ? { ok: true, value: Object.freeze({ kind: "command", toRead: toRead.value }) } : toRead;
}

/** A scenario's tool use or tool result: its own fields only, and a role left out read as none. */
function callIn(raw: unknown, what: "tool use" | "tool result"): Result<Call<ScenarioEffect>> {
  const form = what === "tool use" ? TOOL_USE_FORM : TOOL_RESULT_FORM;
  if (!isRecord(raw)) return refuse(`a scenario's ${what} is ${form}`);
  const allowed = what === "tool use" ? ["role", "tool", "effects", "callId"] : ["role", "tool", "effects", "ok", "callId", "delegatedAgentRuns"];
  const extra = unknownKey(raw, allowed);
  if (extra !== undefined) return refuse(`a scenario's ${what} has no field '${extra}': it is ${form}`);
  if (what === "tool result" && typeof own(raw, "ok") !== "boolean") return refuse(TOOL_RESULT_SAYS_OK);
  const withRole = Object.hasOwn(raw, "role") ? raw : { ...raw, role: null };
  return callOf(withRole, `A scenario's ${what}`, scenarioEffectOf);
}

/** A file a scenario writes, by project path: never the project's root, its configuration at the root, or under .bounded/. */
function writablePathOf(raw: string, named: string): Result<ProjectPath> {
  const path = ProjectPath.parse(raw);
  if (!path.ok) return refuse(`${named} '${raw}': ${path.error}`);
  const value = path.value.value;
  const [first = ""] = value.split("/");
  if (value === ".") return refuse(`${named} '${raw}' is the project's root, not a file`);
  if (first.toLowerCase() === BOUNDED_STATE_DIRECTORY ||(!value.includes("/") && value.toLowerCase().startsWith(CONFIGURATION_NAME))) return refuse(`${named} '${raw}' ${OWNED}`);
  return path;
}

/** Files by project path, each with its text (or, for a change, null: deleted). */
function filesOf<T extends string | null>(raw: object, named: string, isText: (text: unknown) => text is T, notText: (path: string) => string): Result<readonly { readonly path: ProjectPath; readonly text: T }[]> {
  const files: { readonly path: ProjectPath; readonly text: T }[] = [];
  for (const [rawPath, text] of Object.entries(raw)) {
    if (!isText(text)) return refuse(notText(rawPath));
    const path = writablePathOf(rawPath, named);
    if (!path.ok) return path;
    if (files.some((file) => file.path.equals(path.value))) return refuse(`${named} '${rawPath}' is named twice, as '${path.value.value}'`);
    files.push(Object.freeze({ path: path.value, text }));
  }
  return { ok: true, value: Object.freeze(files) };
}

const isString = (text: unknown): text is string => typeof text === "string";
const isStringOrNull = (text: unknown): text is string | null => text === null || typeof text === "string";

/** One step: exactly one of a tool use with its verdict, a tool result with its message, or a change of files. */
function stepOf(raw: unknown): Result<Step> {
  if (!isRecord(raw)) return refuse(STEP_KINDS);
  const kinds = (["toolUse", "toolResult", "changeFiles"] as const).filter((key) => Object.hasOwn(raw, key));
  const [kind, other] = kinds;
  if (kind === undefined) {
    const extra = unknownKey(raw, ["toolUse", "verdict", "toolResult", "afterToolMessage", "changeFiles"]);
    return refuse(extra === undefined ? STEP_KINDS : `a step has no field '${extra}': ${STEP_KINDS}`);
  }
  if (other !== undefined) return refuse(`${STEP_KINDS}, not ${kind} and ${other} together`);
  if (kind === "toolUse") {
    const extra = unknownKey(raw, ["toolUse", "verdict"]);
    if (extra !== undefined) return refuse(`a tool use step has no field '${extra}': it is { toolUse, verdict }`);
    if (!Object.hasOwn(raw, "verdict")) return refuse("a tool use step gives the verdict it expects: { toolUse, verdict }");
    const call = callIn(own(raw, "toolUse"), "tool use");
    if (!call.ok) return call;
    const verdict = Verdict.parse(own(raw, "verdict"));
    return verdict.ok ? { ok: true, value: Object.freeze({ kind, call: call.value, verdict: verdict.value }) } : verdict;
  }
  if (kind === "toolResult") {
    const extra = unknownKey(raw, ["toolResult", "afterToolMessage"]);
    if (extra !== undefined) return refuse(`a tool result step has no field '${extra}': it is { toolResult, afterToolMessage }`);
    const afterToolMessage = own(raw, "afterToolMessage");
    if (!Object.hasOwn(raw, "afterToolMessage") || !isStringOrNull(afterToolMessage)) return refuse("a tool result step gives the message it expects after the tool, or null: { toolResult, afterToolMessage }");
    const rawResult = own(raw, "toolResult");
    const call = callIn(rawResult, "tool result");
    if (!call.ok) return call;
    // callIn read it as a record whose ok is true or false.
    const fieldOfResult = (key: string): unknown => (isRecord(rawResult) ? own(rawResult, key) : undefined);
    const delegates = call.value.effects.filter((effect) => effect.kind === "effect" && effect.effect.kind === "delegate").length;
    const runs = delegatedAgentRunsOf(fieldOfResult("delegatedAgentRuns"), delegates);
    if (!runs.ok) return runs;
    return { ok: true, value: Object.freeze({ kind, call: call.value, ok: fieldOfResult("ok") === true, runs: runs.value, afterToolMessage }) };
  }
  const extra = unknownKey(raw, ["changeFiles"]);
  if (extra !== undefined) return refuse(`a change of files has no field '${extra}': it is { changeFiles }`);
  const rawChanges = own(raw, "changeFiles");
  if (!isRecord(rawChanges)) return refuse("a change of files maps project paths to their new text, or null to delete them");
  if (Object.keys(rawChanges).length === 0) return refuse("a change of files names at least one file");
  const changes = filesOf(rawChanges, "changed file", isStringOrNull, (path) => `changed file '${path}' is its new text, or null to delete it`);
  return changes.ok ? { ok: true, value: Object.freeze({ kind, changes: changes.value }) } : changes;
}

/** One scenario, its refusals naming it by number and, once it is known, its title. */
function scenarioOf(raw: unknown, number: number): Result<Scenario> {
  if (!isRecord(raw)) return refuse(`Scenario ${number} is an object ${SCENARIO_FORM}`);
  const title = own(raw, "title");
  if (typeof title !== "string" || title.trim() === "" || /[\r\n]/.test(title)) return refuse(`Scenario ${number}'s title is one line of text, not blank`);
  const name = `Scenario ${number} ('${title}')`;
  const extra = unknownKey(raw, ["title", "projectFiles", "steps"]);
  if (extra !== undefined) return refuse(`${name} has no field '${extra}': a scenario is ${SCENARIO_FORM}`);
  const rawFiles = own(raw, "projectFiles") ?? {};
  if (!isRecord(rawFiles)) return refuse(`${name}'s projectFiles maps project paths to their text`);
  const projectFiles = filesOf(rawFiles, `${name}'s project file`, isString, (path) => `${name}'s project file '${path}' is text`);
  if (!projectFiles.ok) return projectFiles;
  const rawSteps = own(raw, "steps");
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return refuse(`${name} has no steps: give it a list of steps, at least one of them a tool use`);
  const steps: Step[] = [];
  for (const [index, rawStep] of rawSteps.entries()) {
    const step = stepOf(rawStep);
    if (!step.ok) return refuse(`${name}, step ${index + 1}: ${step.error}`);
    steps.push(step.value);
  }
  if (!steps.some((step) => step.kind === "toolUse")) return refuse(`${name} has no tool use: each scenario judges at least one tool use, { toolUse, verdict }`);
  return { ok: true, value: Object.freeze({ title, projectFiles: projectFiles.value, steps: Object.freeze(steps) }) };
}

// The normal form: what toJSON gives and the catalogue carries.

const effectJSON = (effect: ScenarioEffect): Contract.ScenarioEffectJSON =>
  effect.kind === "effect" ? effect.effect.toJSON() : { kind: "execute", command: effect.toRead.command.value, cwd: effect.toRead.cwd === null ? null : effect.toRead.cwd.value };

function callJSON(call: Call<ScenarioEffect>): Contract.ScenarioToolUseJSON {
  const json = { role: call.role === null ? null : call.role.value, tool: call.tool, effects: call.effects.map(effectJSON) };
  return call.callId === undefined ? json : { ...json, callId: call.callId.value };
}

function stepJSON(step: Step): Contract.ExampleScenarioStepJSON {
  switch (step.kind) {
    case "toolUse":
      return { toolUse: callJSON(step.call), verdict: step.verdict.toJSON() };
    case "toolResult": {
      const { callId, ...call } = callJSON(step.call);
      const toolResult = { ...call, ok: step.ok, ...(callId === undefined ? {} : { callId }), ...(step.runs === undefined ? {} : { delegatedAgentRuns: step.runs.map(delegatedAgentRunJSON) }) };
      return { toolResult, afterToolMessage: step.afterToolMessage };
    }
    case "changeFiles":
      return { changeFiles: Object.fromEntries(step.changes.map(({ path, text }) => [path.value, text])) };
  }
}

const scenarioJSON = (scenario: Scenario): Contract.ExampleScenarioJSON => ({
  title: scenario.title,
  projectFiles: Object.fromEntries(scenario.projectFiles.map(({ path, text }) => [path.value, text])),
  steps: scenario.steps.map(stepJSON),
});

// The one rendering (ADR 2026-031): what a catalogue's reader shows.

const describeScenarioEffect = (effect: ScenarioEffect): string => (effect.kind === "effect" ? describeEffect(effect.effect) : describeExecute(effect.toRead.command, effect.toRead.cwd));
const describeCall = (call: Call<ScenarioEffect>): string => `${call.effects.map(describeScenarioEffect).join("; ")}${call.callId === undefined ? "" : ` (call ${call.callId.value})`}`;
const quotedPaths = (paths: readonly ProjectPath[]): string => paths.map((path) => `\`${path.value}\``).join(", ");

/** What a tool result says of each finished delegated run: the agent the host ran, else the one the delegate effect asked for. */
function finishedRuns(step: Extract<Step, { kind: "toolResult" }>): string {
  const delegates = step.call.effects.flatMap((effect) => (effect.kind === "effect" && effect.effect.kind === "delegate" ? [effect.effect.agent.value] : []));
  return (step.runs ?? []).flatMap((run, index) => (run.finished ? [`; ${run.resolvedAgent?.value ?? delegates[index] ?? ""}'s run finished`] : [])).join("");
}

function stepLine(step: Step, number: number): string {
  switch (step.kind) {
    case "toolUse": {
      const verdict = step.verdict.kind === "allow" ? "allowed" : `refused: ${step.verdict.reason}\n   Redirect: ${step.verdict.redirect}`;
      return `${number}. ${describeCall(step.call)} → ${verdict}`;
    }
    case "toolResult": {
      const message = step.afterToolMessage === null ? "no message" : `message: ${step.afterToolMessage}`;
      return `${number}. Result of ${describeCall(step.call)}, ${step.ok ? "succeeded" : "failed"}${finishedRuns(step)} → ${message}`;
    }
    case "changeFiles": {
      const changed = step.changes.flatMap(({ path, text }) => (text === null ? [] : [path]));
      const deleted = step.changes.flatMap(({ path, text }) => (text === null ? [path] : []));
      const parts = [...(changed.length === 0 ? [] : [`changed: ${quotedPaths(changed)}`]), ...(deleted.length === 0 ? [] : [`deleted: ${quotedPaths(deleted)}`])];
      return `${number}. Files ${parts.join("; ")}.`;
    }
  }
}

function scenarioMarkdown(scenario: Scenario): string {
  const files = scenario.projectFiles.length === 0 ? [] : [`Project files: ${quotedPaths(scenario.projectFiles.map(({ path }) => path))}.`, ""];
  return [`### ${scenario.title}`, "", ...files, ...scenario.steps.map((step, index) => stepLine(step, index + 1))].join("\n");
}

/** Plain data, every object and list in it frozen, in place. */
function deepFrozen<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const item of Object.values(value)) deepFrozen(item);
  return Object.freeze(value);
}

class ExampleScenariosImpl implements Contract.ExampleScenarios {
  declare readonly __brand: "ExampleScenarios";
  declare readonly [exampleScenariosBrand]: true;
  readonly #made = true;
  readonly #markdown: string;
  readonly scenarios: readonly Contract.ExampleScenarioJSON[];

  private constructor(scenarios: readonly Scenario[]) {
    this.scenarios = deepFrozen(scenarios.map(scenarioJSON));
    this.#markdown = scenarios.map(scenarioMarkdown).join("\n\n");
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is ExampleScenariosImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.ExampleScenarios> {
    return readSafely<Contract.ExampleScenarios>("Example scenarios", () => {
      if (ExampleScenariosImpl.made(raw)) return ExampleScenariosImpl.parse(wireFormOf(raw));
      if (!isRecord(raw)) return refuse(FORM);
      const extra = unknownKey(raw, ["scenarios"]);
      if (extra !== undefined) return refuse(`Example scenarios have no field '${extra}': they are { scenarios }`);
      const rawScenarios = own(raw, "scenarios");
      if (!Array.isArray(rawScenarios) || rawScenarios.length === 0) return refuse(FORM);
      const scenarios: Scenario[] = [];
      for (const [index, rawScenario] of rawScenarios.entries()) {
        const scenario = scenarioOf(rawScenario, index + 1);
        if (!scenario.ok) return scenario;
        scenarios.push(scenario.value);
      }
      return { ok: true, value: new ExampleScenariosImpl(scenarios) };
    });
  }

  equals(other: Contract.ExampleScenarios): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.ExampleScenariosJSON {
    return { scenarios: this.scenarios };
  }

  markdown(): string {
    return this.#markdown;
  }
}

export type ExampleScenarios = Contract.ExampleScenarios;
export const ExampleScenarios: Contract.ExampleScenariosFactory = ExampleScenariosImpl;

/**
 * An example's scenarios, as `<slug>.scenarios.ts` default-exports them
 * (ADR 2026-031): typed as authored, and given back as the same plain data,
 * frozen all the way down, so they parse alike in any copy of bounded.
 * ExampleScenarios.parse checks them where they are read: by the package's
 * catalogue build and by the runner.
 */
export function defineExampleScenarios(scenarios: Contract.ExampleScenariosJSON): Contract.ExampleScenariosJSON {
  return deepFrozen(scenarios);
}
