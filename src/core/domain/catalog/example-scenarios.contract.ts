import type { Result } from "../shared/result.ts";
import type { EffectJSON, ExecuteEffectJSON } from "../events/effect.contract.ts";
import type { DelegatedAgentRunJSON } from "../events/tool-result.contract.ts";
import type { ToolKind } from "../events/tool-use.contract.ts";
import type { VerdictJSON } from "../verdicts/verdict.contract.ts";

/** The brand only ExampleScenarios itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const exampleScenariosBrand: unique symbol;

// An example's scenarios (ADR 2026-031): what a pack's example,
// `<slug>.config.ts`, does, as calls in the core's event vocabulary, each
// with the verdict or message it gets. Authored as plain data in
// `<slug>.scenarios.ts` beside the example, run by the package's tests with
// bounded/testing/example-scenarios, and carried in the package catalogue.

/**
 * An execute effect in a scenario: the command and the project directory it
 * runs in (null or left out: the project root). Never a reading: bounded's
 * shell command reader reads the command when the scenario runs, in the
 * scenario's project, as a host does.
 */
export interface ScenarioExecuteJSON {
  readonly kind: "execute";
  readonly command: string;
  readonly cwd?: string | null;
}

/** An effect in a scenario: an effect's wire form, but an execute effect is a command still to be read. */
export type ScenarioEffectJSON = Exclude<EffectJSON, ExecuteEffectJSON> | ScenarioExecuteJSON;

/** A tool use in a scenario: a tool use's wire form without its kind; the role may be left out for none. */
export interface ScenarioToolUseJSON {
  readonly role?: string | null;
  readonly tool: ToolKind;
  readonly effects: readonly ScenarioEffectJSON[];
  readonly callId?: string;
}

/** A tool result in a scenario: a tool result's wire form without its kind; the role may be left out for none. */
export interface ScenarioToolResultJSON extends ScenarioToolUseJSON {
  readonly ok: boolean;
  readonly delegatedAgentRuns?: readonly DelegatedAgentRunJSON[];
}

/** A tool use, judged: the verdict it is expected to get. */
export interface ToolUseStepJSON {
  readonly toolUse: ScenarioToolUseJSON;
  readonly verdict: VerdictJSON;
}

/** A tool's result, after it ran: the message the agent is expected to be told, or null for none. */
export interface ToolResultStepJSON {
  readonly toolResult: ScenarioToolResultJSON;
  readonly afterToolMessage: string | null;
}

/** Files changed between steps, by project path: each one's new text, or null to delete it. */
export interface ChangeFilesStepJSON {
  readonly changeFiles: Readonly<Record<string, string | null>>;
}

/** One step of a scenario: exactly one of a tool use, a tool result or a change of files. */
export type ExampleScenarioStepJSON = ToolUseStepJSON | ToolResultStepJSON | ChangeFilesStepJSON;

/**
 * One scenario: its one-line title, the files its project starts with (by
 * project path; none when left out) and its steps, at least one a tool use.
 * Its project's bounded.config.ts is the example, and bounded is installed
 * in its node_modules: no scenario writes there, in .bounded/ or in .git/.
 */
export interface ExampleScenarioJSON {
  readonly title: string;
  readonly projectFiles?: Readonly<Record<string, string>>;
  readonly steps: readonly ExampleScenarioStepJSON[];
}

/**
 * An example's scenarios, as `<slug>.scenarios.ts` default-exports them, and
 * in their normal form, as toJSON gives them and the package catalogue
 * carries them: every role, list filter and execute cwd written (null for
 * none) and the project files written ({} for none).
 */
export interface ExampleScenariosJSON {
  readonly scenarios: readonly ExampleScenarioJSON[];
}

/**
 * An example's scenarios, checked (ADR 2026-031): each part by the parser
 * that owns it (a tool use's role, tool kind, effects and call id as a tool
 * use's; a verdict as a verdict; an execute command as an execute effect's
 * command and cwd), each refusal naming the scenario and the step.
 */
export interface ExampleScenarios {
  readonly __brand: "ExampleScenarios";
  readonly [exampleScenariosBrand]: true;
  /** The scenarios in their normal form. */
  readonly scenarios: readonly ExampleScenarioJSON[];
  equals(other: ExampleScenarios): boolean;
  /** The normal form. */
  toJSON(): ExampleScenariosJSON;
  /**
   * The scenarios as Markdown, the one rendering every reader of a catalogue
   * shows: per scenario a `###` title, its project files, then each step,
   * numbered: its effects (as messages name them) and call id, then
   * "→ allowed", "→ refused: <reason>" with its redirect on the next line,
   * "→ no message" or "→ message: <text>"; a change of files lists what
   * changed and what was deleted.
   */
  markdown(): string;
}

export interface ExampleScenariosFactory {
  /** The scenarios, or a refusal naming the scenario (its number and title) and the step (its number). Never throws. */
  parse(raw: unknown): Result<ExampleScenarios>;
}
