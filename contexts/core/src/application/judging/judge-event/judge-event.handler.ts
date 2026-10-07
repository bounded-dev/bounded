import { type Composition, Decision, decideEvent, Verdict } from "bounded/domain";
import type { Clock, DecisionLog, JudgeEvent, JudgeEventCommand } from "./judge-event.contract.ts";

const UNRECORDED_REDIRECT = "Make the decision log writable; until decisions can be recorded, every action is refused";

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
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
    this.recordWithinMs = options.recordWithinMs ?? JudgeEventHandler.DEFAULT_RECORD_WITHIN_MS;
  }

  async execute(command: JudgeEventCommand): Promise<Verdict> {
    const judgement = decideEvent(this.composition, command.event);
    const failure = await this.record(() => Decision.of(this.clock.now(), command.event, judgement));
    if (failure === undefined) return judgement.verdict;
    // Fail closed: a refusal stays a refusal; an allow that left no record is refused.
    const { verdict } = judgement;
    if (verdict.kind === "refuse") return Verdict.refuse(`${verdict.reason} (this decision could not be recorded: ${failure})`, verdict.redirect);
    return Verdict.refuse(`The guards allowed this, but the decision could not be recorded: ${failure}`, UNRECORDED_REDIRECT);
  }

  /** Why the decision could not be recorded within the bound, or undefined when it was. Never throws. */
  private async record(decision: () => Decision): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`it did not finish within ${this.recordWithinMs} ms`), this.recordWithinMs);
    });
    try {
      const recorded = (async () => {
        await this.log.record(decision());
        return undefined;
      })();
      return await Promise.race([recorded, late]);
    } catch (thrown) {
      return text(thrown);
    } finally {
      clearTimeout(timer);
    }
  }
}
