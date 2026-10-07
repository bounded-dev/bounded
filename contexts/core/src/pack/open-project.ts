import { type DecisionLog, OpenProjectCommand, OpenProjectHandler, type ProjectConfigSource, type ProjectJudge } from "bounded/application";
import type { Clock } from "bounded/application";
import { FileSystemProjectConfigSource, FileSystemProjectDecisionLogs } from "bounded/adapters/file-system";
import { SystemClock } from "bounded/adapters/system";
import { Verdict } from "bounded/domain";

/** What a host may replace; everything else has a default. */
export interface OpenProjectOptions {
  readonly configSource?: ProjectConfigSource;
  /** The project's decision log; by default `<root>/.bounded/guard-log.jsonl`. */
  readonly log?: DecisionLog;
  readonly clock?: Clock;
  readonly recordWithinMs?: number;
}

/**
 * The composition root a host adapter calls: open the project at `root` (an
 * absolute path) for judging. The judge decides each event with the project's
 * bounded.config.ts and records it; if the configuration cannot be used, or
 * the root is not absolute, it refuses every event.
 */
export async function openProject(root: string, options: OpenProjectOptions = {}): Promise<ProjectJudge> {
  const command = OpenProjectCommand.parse({ root });
  if (!command.ok) {
    const refusal = Verdict.refuse(`This project cannot be opened: ${command.error}`, "Pass the project's absolute root directory to openProject");
    return Object.freeze({ judge: async () => refusal, problem: command.error });
  }
  const { log } = options;
  const logs = log === undefined ? new FileSystemProjectDecisionLogs() : { forProject: () => log };
  const handler = new OpenProjectHandler(options.configSource ?? new FileSystemProjectConfigSource(), logs, options.clock ?? new SystemClock(), {
    ...(options.recordWithinMs === undefined ? {} : { recordWithinMs: options.recordWithinMs }),
  });
  return handler.execute(command.value);
}
