import { AdapterRefusal, type Composition, Ports, type Result, ToolResult, Verdict } from "bounded/domain";
import type { AdapterRefusalInput, JudgeEvent } from "../../guard-log/judge-event/judge-event.contract.ts";
import { attempt, JudgeEventHandler } from "../../guard-log/judge-event/judge-event.handler.ts";
import type { AfterToolOutcome, ProjectLifecycle } from "../../lifecycle/project-lifecycle/project-lifecycle.contract.ts";
import { ProjectLifecycleHandler } from "../../lifecycle/project-lifecycle/project-lifecycle.handler.ts";
import type { Clock, DecisionIds, GuardLog, OpenProject, OpenProjectCommand, OpenProjectOptions, ProjectConfigSource, ProjectGuardLogs, ProjectJudge, ShellCommandReader } from "./open-project.contract.ts";

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
    private readonly guardLogs: ProjectGuardLogs,
    private readonly clock: Clock,
    private readonly options: OpenProjectOptions = {},
  ) {}

  /** Never rejects: whatever goes wrong, the judge refuses every event (and records it, when the log can be opened). */
  async execute(command: OpenProjectCommand): Promise<ProjectJudge> {
    let log: GuardLog | undefined;
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
      // The reader prepares alongside the packs' work; one that fails or runs out of time is let go: reading works unprepared, or says why it cannot.
      const { shellCommandReader } = this.options;
      const preparing = shellCommandReader === undefined ? Promise.resolve() : this.prepare(shellCommandReader);
      await lifecycle.open({ root });
      await preparing;
      const handler = new JudgeEventHandler(composition.value, log, this.clock, {
        ...(this.options.recordWithinMs === undefined ? {} : { recordWithinMs: this.options.recordWithinMs }),
        ...this.idsOption(),
        ...(shellCommandReader === undefined ? {} : { shellCommandReader, projectRoot: root }),
        beforeAllow: async (event) => (event.kind === "tool-use" ? lifecycle.before(event) : Verdict.allow),
      });
      return this.judge(handler, null, lifecycle);
    } catch (thrown) {
      return this.refusing(log, text(thrown));
    }
  }

  /** The reader's preparation, within the packs' bound; resolves whatever it does, a synchronous throw included. */
  private async prepare(reader: ShellCommandReader): Promise<void> {
    const bound = this.options.prepareWithinMs ?? ProjectLifecycleHandler.DEFAULT_PREPARE_WITHIN_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, bound);
    });
    try {
      await Promise.race([attempt(() => reader.prepare()), late]);
    } catch {
      // let go: the judge says why each command cannot be read
    } finally {
      clearTimeout(timer);
    }
  }

  /** The ids option, to pass on to the handlers that record decisions; nothing when it is not given, so each uses its default. */
  private idsOption(): { readonly ids?: DecisionIds } {
    return this.options.ids === undefined ? {} : { ids: this.options.ids };
  }

  private judge(handler: JudgeEvent, problem: string | null, lifecycle?: ProjectLifecycle): ProjectJudge {
    return Object.freeze({
      judge: (event: unknown) => handler.judge(event),
      afterTool: (result: unknown) => afterTool(lifecycle, result),
      refuse: (refusal: AdapterRefusalInput) => handler.refuse(refusal),
      problem,
    });
  }

  /** A judge that refuses every event with `problem`, recording it if it can. */
  private refusing(log: GuardLog | undefined, problem: string): ProjectJudge {
    const refusal = Verdict.refuse(`This project's configuration cannot be used: ${problem}`, FIX);
    try {
      if (log !== undefined) return this.judge(new JudgeEventHandler(null, log, this.clock, { refuseEverything: refusal, ...this.idsOption() }), problem);
    } catch {
      // fall through: refuse without recording
    }
    return Object.freeze({
      judge: async () => refusal,
      afterTool: async () => NOTHING,
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
  private logFor(root: string): GuardLog {
    try {
      return this.guardLogs.forProject(root);
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
