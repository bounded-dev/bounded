import { AfterToolReport, type AgentRunFinished, AgentRunFinishReport, type Composition, corePack, Decision, DecisionTime, type OpenedProject, type LifecycleContext, type Ports, type ToolResult, type ToolUse, Verdict } from "bounded/domain";
import { defaultDecisionIds, nextDecisionId } from "../../bounded-log/judge-event/judge-event.handler.ts";
import type { AfterToolOutcome, Clock, DecisionIds, BoundedLog, ProjectLifecycle, ProjectLifecycleOptions } from "./project-lifecycle.contract.ts";

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

export class ProjectLifecycleHandler implements ProjectLifecycle {
  /** How long one pack's work on opening may take, when the host does not say, before the project opens without it. */
  static readonly DEFAULT_PREPARE_WITHIN_MS = PREPARE_WITHIN_MS;
  private readonly context: LifecycleContext;
  private readonly ids: DecisionIds;
  private readonly prepareWithinMs: number;

  constructor(
    private readonly composition: Composition,
    ports: Ports,
    private readonly log: BoundedLog,
    private readonly clock: Clock,
    options: ProjectLifecycleOptions = {},
  ) {
    this.context = Object.freeze({ composition, ports });
    this.ids = options.ids ?? defaultDecisionIds;
    this.prepareWithinMs = options.prepareWithinMs ?? ProjectLifecycleHandler.DEFAULT_PREPARE_WITHIN_MS;
  }

  async open(project: OpenedProject): Promise<void> {
    const openings = this.composition.read(corePack.points.onProjectOpen);
    if (!openings.ok) return;
    const opened = Object.freeze({ root: project.root });
    await Promise.allSettled(openings.value.map((open) => within(Promise.resolve().then(() => open(opened, this.context)), this.prepareWithinMs)));
  }

  async before(call: ToolUse): Promise<Verdict> {
    const checks = this.composition.entries(corePack.points.beforeTool);
    if (!checks.ok) return Verdict.refuse(`The checks before this call cannot be read: ${checks.error}`, "Select a single copy of the core pack with the packs that contribute them");
    for (const { fromPackId, value: check } of checks.value) {
      const pack = fromPackId.value;
      let verdict: Verdict;
      try {
        const answer = Verdict.parse(await check(call, this.context));
        if (!answer.ok) throw new Error(`it answered with something that is not a verdict: ${answer.error}`);
        verdict = answer.value;
      } catch (thrown) {
        return Verdict.refuse(`${pack} could not check this call before it ran: ${text(thrown)}`, `Report this to the maintainers of ${pack}; the action is refused meanwhile`);
      }
      if (verdict.kind === "refuse") return verdict;
    }
    return Verdict.allow;
  }

  async after(result: ToolResult): Promise<AfterToolOutcome> {
    const checks = this.composition.entries(corePack.points.afterTool);
    if (!checks.ok) return { message: `The checks after this call cannot be read: ${checks.error}` };
    const messages: string[] = [];
    for (const { fromPackId, value: check } of checks.value) {
      const pack = fromPackId.value;
      let report: AfterToolReport | string;
      try {
        const parsed = AfterToolReport.parse(await check(result, this.context));
        report = parsed.ok ? parsed.value : parsed.error;
      } catch (thrown) {
        report = text(thrown);
      }
      if (typeof report === "string") {
        const message = `${pack} could not check this call after it ran: ${report}`;
        messages.push(message);
        await this.record(result, Verdict.refuse(message, `Report this to the maintainers of ${pack}`), null, "could not be checked after it ran");
        continue;
      }
      if (report.message !== null) messages.push(report.message);
      if (report.record !== null) {
        const { verdict, refusedBy, note } = report.record;
        await this.record(result, verdict, refusedBy === null ? null : { packId: fromPackId, effect: refusedBy.effect }, note);
      }
    }
    return { message: messages.length === 0 ? null : messages.join("\n\n") };
  }

  async recordAgentRunFinish(finish: AgentRunFinished): Promise<void> {
    const checks = this.composition.entries(corePack.points.onAgentRunFinish);
    if (!checks.ok) {
      await this.record(finish, Verdict.refuse(`The checks on an agent run's finish cannot be read: ${checks.error}`, "Select a single copy of the core pack with the packs that contribute them"), null, "could not be handled");
      return;
    }
    const run = `${finish.agent.value}'s run ${finish.agentRunId.value}`;
    for (const { fromPackId, value: check } of checks.value) {
      const pack = fromPackId.value;
      let report: AgentRunFinishReport | string;
      try {
        const parsed = AgentRunFinishReport.parse(await check(finish, this.context));
        report = parsed.ok ? parsed.value : parsed.error;
      } catch (thrown) {
        report = text(thrown);
      }
      if (typeof report === "string") {
        await this.record(finish, Verdict.refuse(`${pack} could not handle the finish of ${run}: ${report}`, `Report this to the maintainers of ${pack}`), { packId: fromPackId, effect: null }, "could not be handled");
        continue;
      }
      if (report.record === null) continue;
      const { verdict, note } = report.record;
      await this.record(finish, verdict, verdict.kind === "refuse" ? { packId: fromPackId, effect: null } : null, note);
    }
  }

  /** Record a decision on the result or finish; one that cannot be written changes nothing more: the message already says what happened. */
  private async record(result: ToolResult | AgentRunFinished, verdict: Verdict, refusedBy: Parameters<typeof Decision.of>[3]["refusedBy"], note: string): Promise<void> {
    try {
      const time = DecisionTime.parse(this.clock.now());
      if (!time.ok) return;
      await this.log.record(Decision.of(nextDecisionId(this.ids), time.value.value, result, { verdict, refusedBy }, note));
    } catch {
      // swallowed, as above
    }
  }
}
