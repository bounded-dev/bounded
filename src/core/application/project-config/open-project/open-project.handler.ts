import { AdapterRefusal, AgentRunFinished, type Composition, Decision, DecisionTime, Ports, type Result, ToolResult, Verdict } from "bounded/domain";
import type { AdapterRefusalInput, JudgeEvent } from "../../bounded-log/judge-event/judge-event.contract.ts";
import { defaultDecisionIds, JudgeEventHandler, nextDecisionId } from "../../bounded-log/judge-event/judge-event.handler.ts";
import type { AfterToolOutcome, ProjectLifecycle } from "../../lifecycle/project-lifecycle/project-lifecycle.contract.ts";
import { ProjectLifecycleHandler } from "../../lifecycle/project-lifecycle/project-lifecycle.handler.ts";
import type { Clock, DecisionIds, BoundedLog, OpenProject, OpenProjectCommand, OpenProjectOptions, ProjectConfigSource, ProjectBoundedLogs, ProjectJudge } from "./open-project.contract.ts";

const NOTHING: AfterToolOutcome = Object.freeze({ message: null });

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
    private readonly configSource: ProjectConfigSource,
    private readonly boundedLogs: ProjectBoundedLogs,
    private readonly clock: Clock,
    private readonly options: OpenProjectOptions = {},
  ) {}

  /** Never rejects: whatever goes wrong, the judge refuses every event (and records it, when the log can be opened). */
  async execute(command: OpenProjectCommand): Promise<ProjectJudge> {
    let log: BoundedLog | undefined;
    try {
      const root = command.projectRoot;
      log = this.logFor(root);
      const composition = await this.compose(root);
      if (!composition.ok) return this.refusing(log, composition.error);
      const ports = Ports.forProject(root, this.options.ports ?? []);
      if (!ports.ok) return this.refusing(log, ports.error);
      const missing = composition.value.requiredPorts().find((key) => !ports.value.provides(key));
      if (missing !== undefined) return this.refusing(log, `${missing.owner.value} needs the port '${missing.name}', which this host does not provide: pass it to openProject({ ports })`);
      const lifecycle = new ProjectLifecycleHandler(composition.value, ports.value, log, this.clock, {
        ...(this.options.prepareWithinMs === undefined ? {} : { prepareWithinMs: this.options.prepareWithinMs }),
        ...this.idsOption(),
      });
      await lifecycle.open({ root });
      const handler = new JudgeEventHandler(composition.value, log, this.clock, {
        ...(this.options.recordWithinMs === undefined ? {} : { recordWithinMs: this.options.recordWithinMs }),
        ...this.idsOption(),
        beforeAllow: async (event) => (event.kind === "tool-use" ? lifecycle.before(event) : Verdict.allow),
      });
      return this.judge(handler, null, { lifecycle, log });
    } catch (thrown) {
      return this.refusing(log, text(thrown));
    }
  }

  /** The ids option, to pass on to the handlers that record decisions; nothing when it is not given, so each uses its default. */
  private idsOption(): { readonly ids?: DecisionIds } {
    return this.options.ids === undefined ? {} : { ids: this.options.ids };
  }

  /** A judge over `handler`; with the project's lifecycle and log, it runs the packs' checks after a call and at a run's finish, else those do nothing. */
  private judge(handler: JudgeEvent, problem: string | null, opened?: { readonly lifecycle: ProjectLifecycle; readonly log: BoundedLog }): ProjectJudge {
    return Object.freeze({
      judge: (event: unknown) => handler.judge(event),
      afterTool: (result: unknown) => afterTool(opened?.lifecycle, result),
      refuse: (refusal: AdapterRefusalInput) => handler.refuse(refusal),
      recordAgentRunFinish: async (finish: unknown) => (opened === undefined ? undefined : this.recordAgentRunFinish(opened.lifecycle, opened.log, finish)),
      problem,
    });
  }

  /**
   * Hand an agent run's finish (its wire form) to the packs' finish checks.
   * One that cannot be read is recorded as invalid, and no check runs.
   * Never rejects: a finish has no verdict to enforce.
   */
  private async recordAgentRunFinish(lifecycle: ProjectLifecycle, log: BoundedLog, raw: unknown): Promise<void> {
    try {
      const finish = AgentRunFinished.parse(raw);
      if (finish.ok) return await lifecycle.recordAgentRunFinish(finish.value);
      const time = DecisionTime.parse(this.clock.now());
      if (!time.ok) return;
      const refusal = Verdict.refuse(`The host sent an agent run's finish that cannot be read: ${finish.error}`, "Report this to the maintainers of the host adapter");
      await log.record(Decision.invalid(nextDecisionId(this.options.ids ?? defaultDecisionIds), time.value.value, refusal));
    } catch {
      // A finish that cannot be recorded changes nothing: there is nothing to refuse.
    }
  }

  /** A judge that refuses every event with `problem`, recording it if it can. */
  private refusing(log: BoundedLog | undefined, problem: string): ProjectJudge {
    const refusal = Verdict.refuse(`This project's configuration cannot be used: ${problem}`, FIX);
    try {
      if (log !== undefined) return this.judge(new JudgeEventHandler(null, log, this.clock, { refuseEverything: refusal, ...this.idsOption() }), problem);
    } catch {
      // fall through: refuse without recording
    }
    return Object.freeze({
      judge: async () => refusal,
      afterTool: async () => NOTHING,
      recordAgentRunFinish: async () => {},
      refuse: async (given: AdapterRefusalInput) => {
        const refusal = AdapterRefusal.parse(given);
        return refusal.ok ? refusal.value.verdict : Verdict.refuse(`Judging could not finish: ${refusal.error}`, "Report this to the maintainers of bounded; the action is refused meanwhile");
      },
      problem,
    });
  }

  /** The project's composition, or why its configuration cannot be used. Never throws. */
  private async compose(root: string): Promise<Result<Composition>> {
    const loaded = await this.configSource.load(root);
    if (!loaded.ok) return loaded;
    const composed = loaded.value.compose();
    return composed.ok ? composed : { ok: false, error: `its packs cannot be composed: ${composed.error}` };
  }

  /** The project's log; one that cannot be opened refuses every record, so nothing is allowed unrecorded. */
  private logFor(root: string): BoundedLog {
    try {
      return this.boundedLogs.forProject(root);
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

/** Run the packs' after-tool checks on a tool result; one that cannot be read is reported, and nothing is checked. Never throws. */
async function afterTool(lifecycle: ProjectLifecycle | undefined, raw: unknown): Promise<AfterToolOutcome> {
  try {
    const result = ToolResult.parse(raw);
    if (!result.ok) return { message: `The host sent a tool result that cannot be read: ${result.error}` };
    return lifecycle === undefined ? NOTHING : await lifecycle.after(result.value);
  } catch (thrown) {
    return { message: `The checks after this tool call could not run: ${text(thrown)}` };
  }
}
