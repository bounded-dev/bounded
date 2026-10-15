// The example scenarios runner (ADR 2026-031), published bun-only as
// bounded/testing/example-scenarios: what a pack's package's tests run its
// examples' scenarios with, bounded's own and any third party's alike. It
// uses no test framework and no git. For each scenario it makes a project
// in a temporary directory: the example as its bounded.config.ts, bounded
// linked as node_modules/bounded (the bounded this file ships in, two
// directories up) and each other package the example needs linked under its
// name; it writes the scenario's project files, opens the project as a host
// does, and runs the steps in order, reporting what each judged step was
// expected to get and what it got. The project is removed after, its links
// with it, never what they point at.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type ExampleScenarioJSON,
  type ExampleScenarioStepJSON,
  ExampleScenarios,
  type PortProvision,
  type ScenarioEffectJSON,
  type ScenarioToolUseJSON,
  type VerdictJSON,
} from "bounded/domain";
import { openProject } from "./open-project.ts";

/** bounded's package root: what each scenario's project links node_modules/bounded to. This file is <root>/core/composition-root/. */
const BOUNDED_ROOT = resolve(import.meta.dirname, "..", "..");

/** What the runner sends a shell command reader for one execute effect: the scenario's project, the command and its directory. */
export interface ExampleScenarioCommand {
  readonly projectRoot: string;
  readonly command: string;
  readonly cwd: string | null;
}

/** A shell command reader, as bounded/shell-command-reader's openShellCommandReading makes one: a reading's wire form for each command. */
export interface ExampleScenarioShellCommandReading {
  read(input: ExampleScenarioCommand): Promise<unknown>;
}

export interface ExampleScenariosRunOptions {
  /** The example, `<slug>.config.ts`: an absolute path. */
  readonly examplePath: string;
  /** Its scenarios, as `<slug>.scenarios.ts` default-exports them; ExampleScenarios.parse checks them first. */
  readonly scenarios: unknown;
  /** The packages the example imports other than bounded, by name, each linked into the project's node_modules from its directory. bounded is linked by the runner itself. */
  readonly linkedPackages?: Readonly<Record<string, string>>;
  /** The state directory given to `ports`: kept as it is. Left out, the runner makes a temporary one and removes it after. */
  readonly stateHome?: string;
  /** The adapters for the ports the example's packs declare, as a host provides them, given the state directory. None when left out. */
  readonly ports?: (context: { readonly stateHome: string }) => readonly PortProvision[];
  /** The reader for execute effects' commands, prepared by the caller (bounded/shell-command-reader); needed only by a scenario that runs a shell command. */
  readonly shellCommandReading?: ExampleScenarioShellCommandReading;
}

/** What a judged step was expected to get and got: a tool use's verdict, or the message after a tool's result. */
export type ExampleScenarioOutcome = { readonly verdict: VerdictJSON } | { readonly afterToolMessage: string | null };

export interface ExampleScenarioStepReport {
  /** The step's number in its scenario, from 1; changes of files are numbered but not reported. */
  readonly number: number;
  readonly expected: ExampleScenarioOutcome;
  readonly actual: ExampleScenarioOutcome;
}

export interface ExampleScenarioReport {
  readonly title: string;
  /** Why none of the scenario's steps ran (its project did not open, or it runs a shell command and no reader was given), or null. */
  readonly problem: string | null;
  readonly steps: readonly ExampleScenarioStepReport[];
}

export interface ExampleScenariosReport {
  readonly examplePath: string;
  /** Why no scenario ran (the scenarios do not parse, or the options cannot be used), or null. */
  readonly problem: string | null;
  readonly scenarios: readonly ExampleScenarioReport[];
}

const NO_READER = "this scenario runs a shell command: pass shellCommandReading";
const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/** Whether a scenario runs a shell command: an execute effect in any call. */
const runsShellCommand = (scenario: ExampleScenarioJSON): boolean =>
  scenario.steps.some((step) => {
    const call = "toolUse" in step ? step.toolUse : "toolResult" in step ? step.toolResult : undefined;
    return call?.effects.some((effect) => effect.kind === "execute") === true;
  });

/** Every project path a scenario writes or deletes: its project files, then each change of files. */
const writtenPaths = (scenario: ExampleScenarioJSON): string[] => [
  ...Object.keys(scenario.projectFiles ?? {}),
  ...scenario.steps.flatMap((step) => ("changeFiles" in step ? Object.keys(step.changeFiles) : [])),
];

/** Writes `text` at a project path, with its directories, or deletes the file when `text` is null. */
function writeProjectFile(projectRoot: string, path: string, text: string | null): void {
  const file = join(projectRoot, path);
  if (text === null) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A temporary project: the example as its bounded.config.ts, bounded and the linked packages in its node_modules, and the scenario's project files. */
function projectFor(exampleText: string, linkedPackages: Readonly<Record<string, string>>, scenario: ExampleScenarioJSON): string {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "bounded-example-scenario-")));
  mkdirSync(join(projectRoot, "node_modules"));
  symlinkSync(BOUNDED_ROOT, join(projectRoot, "node_modules", "bounded"), "dir");
  for (const [name, directory] of Object.entries(linkedPackages)) {
    const link = join(projectRoot, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(resolve(directory), link, "dir");
  }
  writeFileSync(join(projectRoot, "bounded.config.ts"), exampleText);
  for (const [path, text] of Object.entries(scenario.projectFiles ?? {})) writeProjectFile(projectRoot, path, text);
  return projectRoot;
}

/** A call's wire form for the judge: each execute effect's command read in the project now, with the reader. */
async function eventEffects(effects: readonly ScenarioEffectJSON[], projectRoot: string, reader: ExampleScenarioShellCommandReading | undefined): Promise<unknown[]> {
  const read: unknown[] = [];
  for (const effect of effects) {
    if (effect.kind !== "execute") {
      read.push(effect);
      continue;
    }
    const cwd = effect.cwd ?? null;
    // A scenario that runs a command never gets here without a reader: it ends with NO_READER first.
    const reading = reader === undefined ? { outcome: "unread", why: NO_READER } : await reader.read({ projectRoot, command: effect.command, cwd });
    read.push({ kind: "execute", command: effect.command, cwd, reading });
  }
  return read;
}

const callEvent = async (kind: "tool-use" | "tool-result", call: ScenarioToolUseJSON, projectRoot: string, reader: ExampleScenarioShellCommandReading | undefined) => ({
  ...call,
  kind,
  effects: await eventEffects(call.effects, projectRoot, reader),
});

/** Runs one scenario in a project of its own, removed after. */
async function runScenario(
  scenario: ExampleScenarioJSON,
  exampleText: string,
  linkedPackages: Readonly<Record<string, string>>,
  stateHome: string,
  options: ExampleScenariosRunOptions,
): Promise<ExampleScenarioReport> {
  const reader = options.shellCommandReading;
  const intoPackages = writtenPaths(scenario).find((path) => path.split("/")[0]?.toLowerCase() === "node_modules");
  if (intoPackages !== undefined) {
    return { title: scenario.title, problem: `this scenario writes '${intoPackages}', under node_modules/, where the runner installs bounded and the linked packages: write no file there`, steps: [] };
  }
  if (reader === undefined && runsShellCommand(scenario)) return { title: scenario.title, problem: NO_READER, steps: [] };
  const projectRoot = projectFor(exampleText, linkedPackages, scenario);
  try {
    const project = await openProject(projectRoot, { ports: options.ports === undefined ? [] : options.ports({ stateHome }) });
    if (project.problem !== null) return { title: scenario.title, problem: project.problem, steps: [] };
    const steps: ExampleScenarioStepReport[] = [];
    for (const [index, step] of scenario.steps.entries()) {
      const report = await runStep(step, index + 1, projectRoot, project, reader);
      if (report !== undefined) steps.push(report);
    }
    return { title: scenario.title, problem: null, steps };
  } finally {
    // rmSync removes a symbolic link, never what it points at.
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function runStep(
  step: ExampleScenarioStepJSON,
  number: number,
  projectRoot: string,
  project: Awaited<ReturnType<typeof openProject>>,
  reader: ExampleScenarioShellCommandReading | undefined,
): Promise<ExampleScenarioStepReport | undefined> {
  if ("toolUse" in step) {
    const verdict = await project.judge(await callEvent("tool-use", step.toolUse, projectRoot, reader));
    return { number, expected: { verdict: step.verdict }, actual: { verdict: verdict.toJSON() } };
  }
  if ("toolResult" in step) {
    const after = await project.afterTool(await callEvent("tool-result", step.toolResult, projectRoot, reader));
    return { number, expected: { afterToolMessage: step.afterToolMessage }, actual: { afterToolMessage: after.message } };
  }
  for (const [path, text] of Object.entries(step.changeFiles)) writeProjectFile(projectRoot, path, text);
  return undefined;
}

/**
 * Runs an example's scenarios, step by step (ADR 2026-031). Scenarios that
 * do not parse, or options that cannot be used, are the report's problem,
 * and no project is made. Never rejects for a scenario's sake: what goes
 * wrong in one is that scenario's problem.
 */
export async function runExampleScenarios(options: ExampleScenariosRunOptions): Promise<ExampleScenariosReport> {
  const { examplePath } = options;
  const unusable = (problem: string): ExampleScenariosReport => ({ examplePath, problem, scenarios: [] });
  const parsed = ExampleScenarios.parse(options.scenarios);
  if (!parsed.ok) return unusable(parsed.error);
  const linkedPackages = options.linkedPackages ?? {};
  if (Object.hasOwn(linkedPackages, "bounded")) return unusable("linkedPackages names bounded, which the runner links itself, to the bounded it ships in: leave bounded out");
  let exampleText: string;
  try {
    exampleText = readFileSync(examplePath, "utf8");
  } catch (thrown) {
    return unusable(`the example ${examplePath} cannot be read: ${message(thrown)}`);
  }
  const missing = Object.entries(linkedPackages).find(([, directory]) => !existsSync(directory));
  if (missing !== undefined) return unusable(`linkedPackages links ${missing[0]} to ${missing[1]}, which does not exist`);
  const madeStateHome = options.stateHome === undefined ? realpathSync(mkdtempSync(join(tmpdir(), "bounded-example-scenarios-state-"))) : undefined;
  const stateHome = options.stateHome ?? madeStateHome ?? "";
  try {
    const scenarios: ExampleScenarioReport[] = [];
    for (const scenario of parsed.value.scenarios) {
      try {
        scenarios.push(await runScenario(scenario, exampleText, linkedPackages, stateHome, options));
      } catch (thrown) {
        scenarios.push({ title: scenario.title, problem: `the scenario could not be run: ${message(thrown)}`, steps: [] });
      }
    }
    return { examplePath, problem: null, scenarios };
  } finally {
    if (madeStateHome !== undefined) rmSync(madeStateHome, { recursive: true, force: true });
  }
}
