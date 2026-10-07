import type { Config, Result, Verdict } from "bounded/domain";
import type { DriftCheck, ShellSnapshots, WatchedFiles } from "../../drift/watch-shell/watch-shell.contract.ts";
import type { DecisionLog } from "../../judging/judge-event/judge-event.contract.ts";

// Wire input: what a host's composition root sends.
export interface OpenProjectInput {
  readonly root: string;
}

// Command: the input once checked.
export interface OpenProjectCommand {
  readonly __brand: "OpenProjectCommand";
  /** The project's root directory, an absolute path. */
  readonly root: string;
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
  load(root: string): Promise<Result<Config>>;
}

/**
 * Each project's watched files and shell snapshots, for undoing what shell commands change.
 * @implementedBy file-system
 */
export interface ProjectDrift {
  forProject(root: string): { readonly files: WatchedFiles; readonly snapshots: ShellSnapshots };
}

/**
 * Each project's decision log.
 * @implementedBy file-system
 */
export interface ProjectDecisionLogs {
  forProject(root: string): DecisionLog;
}
