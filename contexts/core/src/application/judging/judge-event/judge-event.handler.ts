import { type Composition, Decision, decideEvent, Event, Verdict } from "bounded/domain";
import type { Clock, DecisionLog, JudgeEvent, JudgeEventCommand } from "./judge-event.contract.ts";

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

  constructor(
    private readonly composition: Composition,
    private readonly log: DecisionLog,
    private readonly clock: Clock,
    options: { readonly recordWithinMs?: number } = {},
  ) {
    const bound = options.recordWithinMs ?? JudgeEventHandler.DEFAULT_RECORD_WITHIN_MS;
    if (!Number.isFinite(bound) || bound <= 0) throw new RangeError("recordWithinMs must be a finite number of milliseconds above zero");
    this.recordWithinMs = bound;
  }

  async execute(command: JudgeEventCommand): Promise<Verdict> {
    try {
      const event = Event.parse(typeof command === "object" && command !== null ? command.event : undefined);
      if (!event.ok) return Verdict.refuse(`The handler was given something that is not a judge-event command: ${event.error}`, "Build the command with JudgeEventCommand.parse");
      const judgement = decideEvent(this.composition, event.value);
      const failure = await this.record(() => Decision.of(crypto.randomUUID(), this.now(), event.value, judgement));
      if (failure === undefined) return judgement.verdict;
      // Fail closed: a refusal stays a refusal; an allow that left no record is refused.
      const { verdict } = judgement;
      const enforced =
        verdict.kind === "refuse"
          ? Verdict.refuse(`${verdict.reason} (this decision could not be recorded: ${failure.why})`, verdict.redirect)
          : Verdict.refuse(`The guards allowed this, but the decision could not be recorded: ${failure.why}`, UNRECORDED_REDIRECT);
      if (failure.late !== undefined) this.followUp(failure.late.decision, failure.late.landing, enforced);
      return enforced;
    } catch (thrown) {
      return Verdict.refuse(`Judging could not finish: ${text(thrown)}`, "Report this to the maintainers of bounded; the action is refused meanwhile");
    }
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
   * After a timeout, once the late record lands (or fails), append a line
   * with its id saying what was enforced, so the log never contradicts the
   * verdict. If the late record never lands, there is nothing to correct.
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
