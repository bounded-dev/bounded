import type { Config, PathKind, PortProvision, ProjectPath, Result, Verdict } from "bounded/domain";
import type { AfterToolOutcome } from "../../lifecycle/project-lifecycle/project-lifecycle.contract.ts";
import type { AdapterRefusalInput, GuardLog } from "../../guard-log/judge-event/judge-event.contract.ts";

/** The brand only OpenProjectCommand itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const openProjectCommandBrand: unique symbol;

// Out ports this feature shares with judge-event: declared there, listed here so this contract names every port the feature needs.
export type { Clock, GuardLog } from "../../guard-log/judge-event/judge-event.contract.ts";

// Wire input: what a host's composition root sends.
export interface OpenProjectInput {
  readonly projectRoot: string;
}

// Command: the input once checked.
export interface OpenProjectCommand {
  readonly __brand: "OpenProjectCommand";
  readonly [openProjectCommandBrand]: true;
  /** The project's root directory, an absolute path. */
  readonly projectRoot: string;
}

export interface OpenProjectCommandFactory {
  parse(raw: unknown): Result<OpenProjectCommand>;
}

/**
 * A project opened for judging. `judge` decides an event in its wire form and
 * records the decision; when the configuration cannot be used, it refuses
 * every event with the reason, and `problem` says what is wrong.
 */
export interface ProjectJudge {
  judge(event: unknown): Promise<Verdict>;
  /**
   * After a tool ran (its result in wire form): run the packs' after-tool
   * checks and say what they found; `message` is null when there is nothing
   * to tell the agent. Never throws.
   */
  afterTool(result: unknown): Promise<AfterToolOutcome>;
  /** Record a refusal the host adapter made itself, before an event existed, and return it. Never throws. */
  refuse(refusal: AdapterRefusalInput): Promise<Verdict>;
  readonly problem: string | null;
}

// In port: what this feature offers.
/** Open a project for judging: load its configuration, compose its packs, and give a judge that never fails open. */
export interface OpenProject {
  execute(command: OpenProjectCommand): Promise<ProjectJudge>;
}

// Out ports: exactly what this feature needs (with the judge-event feature's Clock).
/**
 * A project's configuration, made by defineConfig.
 * @implementedBy file-system
 */
export interface ProjectConfigSource {
  load(projectRoot: string): Promise<Result<Config>>;
}

/**
 * Each project's guard log.
 * @implementedBy file-system
 */
export interface ProjectGuardLogs {
  forProject(projectRoot: string): GuardLog;
}

/**
 * What is at a path in each project, for the packs that prepare when it
 * opens: undefined when it cannot be told.
 * @implementedBy file-system
 */
export interface ProjectPathKinds {
  forProject(projectRoot: string): (path: ProjectPath) => PathKind | undefined;
}

/** How an open-project handler is set up, beyond its out ports. */
export interface OpenProjectOptions {
  /** How long recording a decision may take before the event is refused. */
  readonly recordWithinMs?: number;
  readonly pathKinds?: ProjectPathKinds;
  /** How long each pack's work on opening may take before the project opens without it. */
  readonly prepareWithinMs?: number;
  /** Adapters for the ports the selected packs declare, from the host's composition root. */
  readonly ports?: readonly PortProvision[];
}
