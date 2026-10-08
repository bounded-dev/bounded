import { type Composition, composeConfig, corePack, type OpenedProject, type ProjectPath, type Result, ToolResult, Verdict } from "bounded/domain";
import type { DriftCheck, WatchShell } from "../../drift/watch-shell/watch-shell.contract.ts";
import { WatchShellHandler } from "../../drift/watch-shell/watch-shell.handler.ts";
import type { AdapterRefusalInput, Clock, DecisionLog } from "../../judging/judge-event/judge-event.contract.ts";
import { JudgeEventHandler } from "../../judging/judge-event/judge-event.handler.ts";
import type { OpenProject, OpenProjectCommand, ProjectConfigSource, ProjectDecisionLogs, ProjectDrift, ProjectJudge, ProjectPathKinds } from "./open-project.contract.ts";

const NOTHING: DriftCheck = Object.freeze({ changed: Object.freeze([]), restored: true, message: null });

const FIX = "Fix bounded.config.ts in the project root (see docs/configuration.md); until then every action is refused";

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

/** How long one pack's work on opening may take before the project opens without it. */
const PREPARE_WITHIN_MS = 5000;

/** `work`, or a rejection once `ms` have passed. */
function within(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export class OpenProjectHandler implements OpenProject {
  constructor(
    private readonly configs: ProjectConfigSource,
    private readonly logs: ProjectDecisionLogs,
    private readonly clock: Clock,
    private readonly options: { readonly recordWithinMs?: number; readonly drift?: ProjectDrift; readonly pathKinds?: ProjectPathKinds; readonly prepareWithinMs?: number } = {},
  ) {}

  /** Never rejects: whatever goes wrong, the judge refuses every event (and records it, when the log can be opened). */
  async execute(command: OpenProjectCommand): Promise<ProjectJudge> {
    let log: DecisionLog | undefined;
    try {
      const root = command.root;
      log = this.logFor(root);
      const composition = await this.compose(root);
      if (!composition.ok) return this.refusing(log, composition.error);
      await this.prepare(root, composition.value);
      const drift = this.options.drift?.forProject(root);
      const watch = drift === undefined ? undefined : new WatchShellHandler(composition.value, drift.files, drift.snapshots, log, this.clock);
      const handler = new JudgeEventHandler(composition.value, log, this.clock, {
        ...(this.options.recordWithinMs === undefined ? {} : { recordWithinMs: this.options.recordWithinMs }),
        ...(watch === undefined ? {} : { beforeAllow: async (event) => (event.kind === "tool-use" ? watch.snapshot(event) : Verdict.allow) }),
      });
      return this.judge(handler, null, watch);
    } catch (thrown) {
      return this.refusing(log, text(thrown));
    }
  }

  /** Runs what each pack does when a project opens. One that fails leaves its own guards to refuse what they cannot check. */
  private async prepare(root: string, composition: Composition): Promise<void> {
    const openings = composition.read(corePack.points.onProjectOpen);
    if (!openings.ok) return;
    const kindOf = this.options.pathKinds?.forProject(root);
    const project: OpenedProject = Object.freeze({ root, kindOfPath: (path: ProjectPath) => kindOf?.(path) });
    const withinMs = this.options.prepareWithinMs ?? PREPARE_WITHIN_MS;
    await Promise.allSettled(openings.value.map((open) => within(Promise.resolve().then(() => open(project, composition)), withinMs)));
  }

  private judge(handler: JudgeEventHandler, problem: string | null, watch?: WatchShell): ProjectJudge {
    return Object.freeze({
      judge: (event: unknown) => handler.judge(event),
      afterTool: (result: unknown) => afterTool(watch, result),
      refuse: (refusal: AdapterRefusalInput) => handler.refuse(refusal),
      problem,
    });
  }

  /** A judge that refuses every event with `problem`, recording it if it can. */
  private refusing(log: DecisionLog | undefined, problem: string): ProjectJudge {
    const refusal = Verdict.refuse(`This project's configuration cannot be used: ${problem}`, FIX);
    try {
      if (log !== undefined) return this.judge(new JudgeEventHandler(null, log, this.clock, { refuseEverything: refusal }), problem);
    } catch {
      // fall through: refuse without recording
    }
    return Object.freeze({
      judge: async () => refusal,
      afterTool: async () => NOTHING,
      refuse: async (given: AdapterRefusalInput) => Verdict.refuse(String(given?.reason ?? ""), String(given?.redirect ?? "")),
      problem,
    });
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

/** Check a tool result for drift; with no watching, or a result that cannot be read, nothing is undone. Never throws. */
async function afterTool(watch: WatchShell | undefined, raw: unknown): Promise<DriftCheck> {
  try {
    const result = ToolResult.parse(raw);
    if (!result.ok) return { ...NOTHING, message: `The host sent a tool result that cannot be read: ${result.error}` };
    return watch === undefined ? NOTHING : await watch.verify(result.value);
  } catch (thrown) {
    return { changed: [], restored: false, message: `Protected files could not be checked after this command: ${text(thrown)}` };
  }
}
