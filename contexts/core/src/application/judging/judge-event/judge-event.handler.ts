import { type Composition, Decision, decideEvent, Event, type Judgement, Verdict } from "bounded/domain";
import type { AdapterRefusalInput, Clock, DecisionIds, DecisionLog, JudgeEvent, JudgeEventCommand } from "./judge-event.contract.ts";

const UNRECORDED_REDIRECT = "Make the decision log writable; until decisions can be recorded, every action is refused";
const LATE_NOTE = "not recorded in time; enforced: refuse";

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

function isIso(time: unknown): time is string {
  try {
    return typeof time === "string" && new Date(time).toISOString() === time;
  } catch {
    return false;
  }
}

/** Why recording failed; when it timed out, the record that may still land. */
interface Failure {
  readonly why: string;
  readonly late?: { readonly decision: Decision; readonly landing: Promise<void> };
}

export class JudgeEventHandler implements JudgeEvent {
  /** How long a decision may take to record before the action is refused: a hook must answer promptly. */
  static readonly DEFAULT_RECORD_WITHIN_MS = 2000;
  private readonly recordWithinMs: number;
  private readonly decide: (event: Event) => Judgement;
  private readonly ids: DecisionIds;
  private readonly beforeAllow: ((event: Event) => Promise<Verdict>) | undefined;

  /**
   * `options.refuseEverything` makes every event get that refusal, recorded
   * as usual: for a project whose configuration cannot be used. Without it,
   * events are decided by the composition's guards.
   */
  constructor(
    composition: Composition | null,
    private readonly log: DecisionLog,
    private readonly clock: Clock,
    options: {
      readonly recordWithinMs?: number;
      readonly refuseEverything?: Verdict;
      readonly ids?: DecisionIds;
      /** Run when the guards allow an event, before it is recorded; a refusal replaces the allow. */
      readonly beforeAllow?: (event: Event) => Promise<Verdict>;
    } = {},
  ) {
    const bound = options.recordWithinMs ?? JudgeEventHandler.DEFAULT_RECORD_WITHIN_MS;
    if (!Number.isFinite(bound) || bound <= 0) throw new RangeError("recordWithinMs must be a finite number of milliseconds above zero");
    this.recordWithinMs = bound;
    this.ids = options.ids ?? { next: () => crypto.randomUUID() };
    this.beforeAllow = options.beforeAllow;
    const refusal = options.refuseEverything;
    this.decide = refusal === undefined ? (event) => decideEvent(composition, event) : () => ({ verdict: refusal, refusedBy: null });
  }

  async execute(command: JudgeEventCommand): Promise<Verdict> {
    try {
      const event = Event.parse(typeof command === "object" && command !== null ? command.event : undefined);
      if (!event.ok) return Verdict.refuse(`The handler was given something that is not a judge-event command: ${event.error}`, "Build the command with JudgeEventCommand.parse");
      const judgement = await this.judged(event.value);
      return await this.settle(judgement, () => Decision.of(this.ids.next(), this.now(), event.value, judgement));
    } catch (thrown) {
      return Verdict.refuse(`Judging could not finish: ${text(thrown)}`, "Report this to the maintainers of bounded; the action is refused meanwhile");
    }
  }

  /** The guards' judgement, then the check before allowing, which can still refuse. */
  private async judged(event: Event): Promise<Judgement> {
    const judgement = this.decide(event);
    if (judgement.verdict.kind !== "allow" || this.beforeAllow === undefined) return judgement;
    try {
      const verdict = await this.beforeAllow(event);
      return verdict.kind === "allow" ? judgement : { verdict, refusedBy: null };
    } catch (thrown) {
      return { verdict: Verdict.refuse(`The check before allowing this failed: ${text(thrown)}`, "Report this to the maintainers of bounded; the action is refused meanwhile"), refusedBy: null };
    }
  }

  /** Judge an event in its wire form: one that cannot be read is refused and recorded as invalid. Never throws. */
  async judge(raw: unknown): Promise<Verdict> {
    try {
      const event = Event.parse(raw);
      if (event.ok) {
        const judgement = await this.judged(event.value);
        return await this.settle(judgement, () => Decision.of(this.ids.next(), this.now(), event.value, judgement));
      }
      const refusal = Verdict.refuse(`The host sent an event that cannot be read: ${event.error}`, "Report this to the maintainers of the host adapter; the action is refused meanwhile");
      return await this.settle({ verdict: refusal, refusedBy: null }, () => Decision.invalid(this.ids.next(), this.now(), refusal));
    } catch (thrown) {
      return Verdict.refuse(`Judging could not finish: ${text(thrown)}`, "Report this to the maintainers of bounded; the action is refused meanwhile");
    }
  }

  /**
   * Record a refusal the host adapter made itself, before the core saw an
   * event (a path outside the project, a call it cannot translate, a
   * deadline), and return it. Recorded like any decision. Never throws.
   */
  async refuse(refusal: AdapterRefusalInput): Promise<Verdict> {
    try {
      const given = typeof refusal === "object" && refusal !== null ? refusal : ({} as Partial<AdapterRefusalInput>);
      const verdict = Verdict.refuse(String(given.reason ?? ""), String(given.redirect ?? ""));
      const role = typeof given.role === "string" ? given.role : null;
      return await this.settle({ verdict, refusedBy: null }, () =>
        Decision.adapter(this.ids.next(), this.now(), { role, tool: String(given.tool ?? "unknown"), input: given.input, verdict }),
      );
    } catch (thrown) {
      return Verdict.refuse(`Judging could not finish: ${text(thrown)}`, "Report this to the maintainers of bounded; the action is refused meanwhile");
    }
  }

  /** Record the decision and return the verdict to enforce: fail closed when it cannot be recorded. */
  private async settle(judgement: Judgement, build: () => Decision): Promise<Verdict> {
    const failure = await this.record(build);
    if (failure === undefined) return judgement.verdict;
    // Fail closed: a refusal stays a refusal; an allow that left no record is refused.
    const { verdict } = judgement;
    const enforced =
      verdict.kind === "refuse"
        ? Verdict.refuse(`${verdict.reason} (this decision could not be recorded: ${failure.why})`, verdict.redirect)
        : Verdict.refuse(`The guards allowed this, but the decision could not be recorded: ${failure.why}`, UNRECORDED_REDIRECT);
    if (failure.late !== undefined) this.followUp(failure.late.decision, failure.late.landing, enforced);
    return enforced;
  }

  private now(): string {
    const time = this.clock.now();
    if (!isIso(time)) throw new Error(`the clock gave '${text(time)}', not an ISO 8601 time`);
    return time;
  }

  /** Why the decision could not be recorded within the bound, or undefined when it was. Never throws. */
  private async record(build: () => Decision): Promise<Failure | undefined> {
    let decision: Decision;
    try {
      decision = build();
    } catch (thrown) {
      return { why: text(thrown) };
    }
    const landing = (async () => this.log.record(decision))();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Failure>((resolve) => {
      timer = setTimeout(() => resolve({ why: `it did not finish within ${this.recordWithinMs} ms`, late: { decision, landing } }), this.recordWithinMs);
    });
    try {
      return await Promise.race([landing.then(() => undefined), late]);
    } catch (thrown) {
      return { why: text(thrown) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * After a timeout, once the late record settles, append a line with its id
   * saying what was enforced, so the log never contradicts the verdict. The
   * line is appended whether the late record landed or failed; if it never
   * settles, nothing is appended.
   */
  private followUp(decision: Decision, landing: Promise<void>, enforced: Verdict): void {
    const write = (): void => {
      let time = decision.time;
      try {
        time = this.now();
      } catch {
        // keep the decision's own time
      }
      (async () => this.log.record(Decision.enforced(decision, time, enforced, LATE_NOTE)))().catch(() => {});
    };
    landing.then(write, write);
  }
}
