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

  /** Never rejects: whatever goes wrong, the judge refuses every event (and records it, when the log can be opened). */
  async execute(command: OpenProjectCommand): Promise<ProjectJudge> {
    let log: DecisionLog | undefined;
    try {
      const root = command.root;
      log = this.logFor(root);
      const composition = await this.compose(root);
      if (!composition.ok) return this.refusing(log, composition.error);
      return this.judge(new JudgeEventHandler(composition.value, log, this.clock, this.options), null);
    } catch (thrown) {
      return this.refusing(log, text(thrown));
    }
  }

  private judge(handler: JudgeEventHandler, problem: string | null): ProjectJudge {
    return Object.freeze({ judge: (event: unknown) => handler.judge(event), problem });
  }

  /** A judge that refuses every event with `problem`, recording it if it can. */
  private refusing(log: DecisionLog | undefined, problem: string): ProjectJudge {
    const refusal = Verdict.refuse(`This project's configuration cannot be used: ${problem}`, FIX);
    try {
      if (log !== undefined) return this.judge(new JudgeEventHandler(null, log, this.clock, { refuseEverything: refusal }), problem);
    } catch {
      // fall through: refuse without recording
    }
    return Object.freeze({ judge: async () => refusal, problem });
  }

  /** The project's composition, or why its configuration cannot be used. Never throws. */
  private async compose(root: string): Promise<Result<Composition>> {
    let loaded: unknown;
    try {
      loaded = await this.configs.load(root);
    } catch (thrown) {
      return { ok: false, error: `the configuration source failed: ${text(thrown)}` };
    }
    if (typeof loaded !== "object" || loaded === null || !("ok" in loaded)) return { ok: false, error: "the configuration source returned no result" };
    const result = loaded as Result<Parameters<typeof composeConfig>[0]>;
    if (!result.ok) return { ok: false, error: typeof result.error === "string" ? result.error : "the configuration source returned no reason" };
    const composed = composeConfig(result.value);
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
