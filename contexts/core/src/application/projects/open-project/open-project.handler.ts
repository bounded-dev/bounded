import { type Composition, composeConfig, type Result, Verdict } from "bounded/domain";
import type { Clock, DecisionLog } from "../../judging/judge-event/judge-event.contract.ts";
import { JudgeEventHandler } from "../../judging/judge-event/judge-event.handler.ts";
import type { OpenProject, OpenProjectCommand, ProjectConfigSource, ProjectDecisionLogs, ProjectJudge } from "./open-project.contract.ts";

const FIX = "Fix bounded.config.ts in the project root (see docs/configuration.md); until then every action is refused";

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

export class OpenProjectHandler implements OpenProject {
  constructor(
    private readonly configs: ProjectConfigSource,
    private readonly logs: ProjectDecisionLogs,
    private readonly clock: Clock,
    private readonly options: { readonly recordWithinMs?: number } = {},
  ) {}

  async execute(command: OpenProjectCommand): Promise<ProjectJudge> {
    const log = this.logFor(command.root);
    const composition = await this.compose(command.root);
    if (!composition.ok) {
      const refusal = Verdict.refuse(`This project's configuration cannot be used: ${composition.error}`, FIX);
      return this.judge(new JudgeEventHandler(null, log, this.clock, { ...this.options, refuseEverything: refusal }), composition.error);
    }
    return this.judge(new JudgeEventHandler(composition.value, log, this.clock, this.options), null);
  }

  private judge(handler: JudgeEventHandler, problem: string | null): ProjectJudge {
    return Object.freeze({ judge: (event: unknown) => handler.judge(event), problem });
  }

  /** The project's composition, or why its configuration cannot be used. Never throws. */
  private async compose(root: string): Promise<Result<Composition>> {
    let loaded: Awaited<ReturnType<ProjectConfigSource["load"]>>;
    try {
      loaded = await this.configs.load(root);
    } catch (thrown) {
      return { ok: false, error: `the configuration source failed: ${text(thrown)}` };
    }
    if (!loaded.ok) return loaded;
    const composed = composeConfig(loaded.value);
    return composed.ok ? composed : { ok: false, error: `its packs cannot be composed: ${composed.error}` };
  }

  /** The project's log; one that cannot be opened refuses every record, so nothing is allowed unrecorded. */
  private logFor(root: string): DecisionLog {
    try {
      return this.logs.forProject(root);
    } catch (thrown) {
      const why = text(thrown);
      return {
        record: async () => {
          throw new Error(why);
        },
      };
    }
  }
}
