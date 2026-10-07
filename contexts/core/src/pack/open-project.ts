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
  try {
    const command = OpenProjectCommand.parse({ root });
    if (!command.ok) return refusingAll(`This project cannot be opened: ${command.error}`, "Pass the project's absolute root directory to openProject", command.error);
    const { log } = options;
    const logs = log === undefined ? new FileSystemProjectDecisionLogs() : { forProject: () => log };
    const handler = new OpenProjectHandler(options.configSource ?? new FileSystemProjectConfigSource(), logs, options.clock ?? new SystemClock(), {
      ...(options.recordWithinMs === undefined ? {} : { recordWithinMs: options.recordWithinMs }),
    });
    return await handler.execute(command.value);
  } catch (thrown) {
    // Never rejects: a host must always get a judge, and this one refuses.
    const problem = thrown instanceof Error ? thrown.message : "the project could not be opened";
    return refusingAll(`This project cannot be opened: ${problem}`, "Report this to the maintainers of bounded; every action is refused meanwhile", problem);
  }
}

function refusingAll(reason: string, redirect: string, problem: string): ProjectJudge {
  const refusal = Verdict.refuse(reason, redirect);
  return Object.freeze({ judge: async () => refusal, problem });
}

// Frozen, so code loaded later cannot patch it.
Object.freeze(openProject);
