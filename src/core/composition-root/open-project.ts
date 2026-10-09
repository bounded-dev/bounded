import { type BoundedLog, OpenProjectCommand, OpenProjectHandler, type ProjectConfigSource, type ProjectJudge } from "bounded/application";
import type { Clock } from "bounded/application";
import { CheckedProjectConfigSource, FileSystemProjectConfigSource, FileSystemProjectBoundedLogs, RandomDecisionIds, SystemClock } from "bounded/adapters";
import { AdapterRefusal, type PortProvision, Verdict } from "bounded/domain";

/** What a host may replace; everything else has a default. */
export interface OpenProjectOptions {
  readonly configSource?: ProjectConfigSource;
  /** The project's Bounded log; by default `<root>/.bounded/log.jsonl`. */
  readonly boundedLog?: BoundedLog;
  readonly clock?: Clock;
  readonly recordWithinMs?: number;
  /** How long each pack's work on opening may take before the project opens without it; 5 seconds by default. */
  readonly prepareWithinMs?: number;
  /** Adapters for the ports the selected packs declare (a pack's adapter package makes them); none by default: the core cannot import a pack. */
  readonly ports?: readonly PortProvision[];
}

/**
 * The composition root a host adapter calls: open the project at `root` (an
 * absolute path) for judging. The judge decides each event with the
 * project's bounded.config.ts and records it; if the configuration cannot be
 * used, or the root is not absolute, it refuses every event. The host
 * adapter builds each execute effect's reading itself, with bounded's reader
 * (bounded/shell-command-reader, ADR 2026-020), before it asks the judge.
 */
export async function openProject(projectRoot: string, givenOptions: OpenProjectOptions = {}): Promise<ProjectJudge> {
  // An untyped caller may pass null: it still gets a judge.
  const options: OpenProjectOptions = givenOptions ?? {};
  try {
    const command = OpenProjectCommand.parse({ projectRoot });
    if (!command.ok) return refusingAll(`This project cannot be opened: ${command.error}`, "Pass the project's absolute root directory to openProject", command.error);
    const { boundedLog } = options;
    const boundedLogs = boundedLog === undefined ? new FileSystemProjectBoundedLogs() : { forProject: () => boundedLog };
    const handler = new OpenProjectHandler(new CheckedProjectConfigSource(options.configSource ?? new FileSystemProjectConfigSource()), boundedLogs, options.clock ?? new SystemClock(), {
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
