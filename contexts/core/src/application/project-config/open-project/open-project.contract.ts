import type { Config, PathKind, ProjectPath, Result, Verdict } from "bounded/domain";
import type { DriftCheck, ShellSnapshots, WatchedFiles } from "../../drift/watch-shell/watch-shell.contract.ts";
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
   * After a tool ran (its result in wire form): undo what a shell command
   * changed in watched files and say what happened; `message` is null when
   * nothing changed. Never throws.
   */
  afterTool(result: unknown): Promise<DriftCheck>;
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
 * Each project's watched files and shell snapshots, for undoing what shell commands change.
 * @implementedBy file-system
 */
export interface ProjectDrift {
  forProject(projectRoot: string): { readonly files: WatchedFiles; readonly snapshots: ShellSnapshots };
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
  readonly drift?: ProjectDrift;
  readonly pathKinds?: ProjectPathKinds;
  /** How long each pack's work on opening may take before the project opens without it. */
  readonly prepareWithinMs?: number;
}
