import type { Config, Result, Verdict } from "bounded/domain";
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
 * Each project's decision log.
 * @implementedBy file-system
 */
export interface ProjectDecisionLogs {
  forProject(root: string): DecisionLog;
}
