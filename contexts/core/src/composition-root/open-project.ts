import { type GuardLog, OpenProjectCommand, OpenProjectHandler, type ProjectConfigSource, type ProjectJudge } from "bounded/application";
import type { Clock } from "bounded/application";
import { CheckedProjectConfigSource, FileSystemProjectConfigSource, FileSystemProjectGuardLogs, RandomDecisionIds, SystemClock } from "bounded/adapters";
import { AdapterRefusal, type PortProvision, Verdict } from "bounded/domain";

/** What a host may replace; everything else has a default. */
export interface OpenProjectOptions {
  readonly configSource?: ProjectConfigSource;
  /** The project's guard log; by default `<root>/.bounded/guard-log.jsonl`. */
  readonly guardLog?: GuardLog;
  readonly clock?: Clock;
  readonly recordWithinMs?: number;
  /** How long each pack's work on opening may take before the project opens without it; 5 seconds by default. */
  readonly prepareWithinMs?: number;
  /** Adapters for the ports the selected packs declare (a pack's adapter package makes them); none by default: the core cannot import a pack. */
  readonly ports?: readonly PortProvision[];
}

/**
 * The composition root a host adapter calls: open the project at `root` (an
 * absolute path) for judging. The judge decides each event with the project's
 * bounded.config.ts and records it; if the configuration cannot be used, or
 * the root is not absolute, it refuses every event.
 */
export async function openProject(projectRoot: string, options: OpenProjectOptions = {}): Promise<ProjectJudge> {
  try {
    const command = OpenProjectCommand.parse({ projectRoot });
    if (!command.ok) return refusingAll(`This project cannot be opened: ${command.error}`, "Pass the project's absolute root directory to openProject", command.error);
    const { guardLog } = options;
    const guardLogs = guardLog === undefined ? new FileSystemProjectGuardLogs() : { forProject: () => guardLog };
    const handler = new OpenProjectHandler(new CheckedProjectConfigSource(options.configSource ?? new FileSystemProjectConfigSource()), guardLogs, options.clock ?? new SystemClock(), {
      ...(options.recordWithinMs === undefined ? {} : { recordWithinMs: options.recordWithinMs }),
      ...(options.prepareWithinMs === undefined ? {} : { prepareWithinMs: options.prepareWithinMs }),
      ...(options.ports === undefined ? {} : { ports: options.ports }),
      ids: new RandomDecisionIds(),
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
  return Object.freeze({
    judge: async () => refusal,
    afterTool: async () => ({ message: null }),
    refuse: async (given: unknown) => {
      const parsed = AdapterRefusal.parse(given);
      return parsed.ok ? parsed.value.verdict : refusal;
    },
    problem,
  });
}

// Frozen, so code loaded later cannot patch it.
Object.freeze(openProject);
