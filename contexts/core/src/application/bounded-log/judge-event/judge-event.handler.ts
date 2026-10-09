import { AdapterRefusal, type Composition, Decision, DecisionId, DecisionTime, decideEvent, type Event, type ExecuteEffect, type Judgement, ShellCommandReading, ToolUse, Verdict } from "bounded/domain";
import { JudgeEventCommand as JudgeEventCommandFactory } from "./judge-event.command.ts";
import type { AdapterRefusalInput, Clock, DecisionIds, BoundedLog, JudgeEvent, JudgeEventCommand, JudgeEventOptions, ShellCommandReader } from "./judge-event.contract.ts";

const UNRECORDED_REDIRECT = "Make the Bounded log writable; until decisions can be recorded, every action is refused";
const LATE_NOTE = "not recorded in time; enforced: refuse";

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

const NO_READER = "this project was opened without a shell command reader: the host passes one to openProject";

/** `work`'s promise; a synchronous throw becomes its rejection, so a reader that throws is handled as one that rejects. */
export function attempt<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(work()));
}

/** An unread reading saying `why`; one whose why cannot be used says so instead. */
function unread(why: string): ShellCommandReading {
  const reading = ShellCommandReading.parse({ outcome: "unread", why });
  if (reading.ok) return reading.value;
  const fallback = ShellCommandReading.parse({ outcome: "unread", why: "the shell command reader failed without saying why" });
  if (!fallback.ok) throw new Error(fallback.error);
  return fallback.value;
}

/** What `reader` makes of `effect`'s command: its answer parsed, or unread saying why. Never rejects. */
async function readingOf(reader: ShellCommandReader, projectRoot: string, effect: ExecuteEffect): Promise<ShellCommandReading> {
  try {
    const answer = await attempt(() => reader.read(projectRoot, effect.command, effect.cwd));
    const reading = ShellCommandReading.parse(answer);
    return reading.ok ? reading.value : unread(`the shell command reader gave a reading that cannot be used: ${reading.error}`);
  } catch (thrown) {
    return unread(text(thrown));
  }
}

/** Without a composition, and no refusal given for that, every event is refused. */
const NO_COMPOSITION = Verdict.refuse("Dispatch was given something that is not a composition", "Compose the selected packs with Composition.compose and dispatch over the result");

/**
 * The next decision id. What the ids port gives is parsed again: a host's
 * ids source is unchecked at run time, so wire text is accepted with the same
 * check, and anything else (a look-alike DecisionId did not make) throws, so
 * the decision is not recorded and fails closed.
 */
export function nextDecisionId(ids: DecisionIds): DecisionId {
  const id = DecisionId.parse(ids.next());
  if (!id.ok) throw new Error(`the decision ids gave an invalid id: ${id.error}`);
  return id.value;
}

/**
 * The ids a handler uses when it is given none: a DecisionId of a random UUID
 * for each decision. Only the default for code that builds a handler
 * directly; openProject gives the RandomDecisionIds adapter instead.
 */
export const defaultDecisionIds: DecisionIds = Object.freeze({
  next: (): DecisionId => {
    const id = DecisionId.parse(crypto.randomUUID());
    if (!id.ok) throw new Error(`the decision ids gave an invalid id: ${id.error}`);
    return id.value;
  },
});

/** Why recording failed; when it timed out, the record that may still land. */
interface Failure {
  readonly why: string;
  readonly late?: { readonly decision: Decision; readonly landing: Promise<void> };
}

export class JudgeEventHandler implements JudgeEvent {
  /** How long a decision may take to record before the action is refused: a hook must answer promptly. */
  static readonly DEFAULT_RECORD_WITHIN_MS = 2000;
  /** How long reading an event's shell commands may take before those still unread are judged unread. */
  static readonly DEFAULT_READ_WITHIN_MS = 2000;
  private readonly recordWithinMs: number;
  private readonly readWithinMs: number;
  private readonly decide: (event: Event) => Judgement;
  /** Whether events are decided by the guards: a handler refusing everything reads no command. */
  private readonly decidesByGuards: boolean;
  private readonly ids: DecisionIds;
  private readonly beforeAllow: ((event: Event) => Promise<Verdict>) | undefined;
  private readonly reader: { readonly shellCommandReader: ShellCommandReader; readonly projectRoot: string } | undefined;

  /**
   * `options.refuseEverything` makes every event get that refusal, recorded
   * as usual: for a project whose configuration cannot be used. Without it,
   * events are decided by the composition's guards, after every execute
   * effect's command is read by `options.shellCommandReader`.
   */
  constructor(
    composition: Composition | null,
    private readonly log: BoundedLog,
    private readonly clock: Clock,
    options: JudgeEventOptions = {},
  ) {
    const bound = options.recordWithinMs ?? JudgeEventHandler.DEFAULT_RECORD_WITHIN_MS;
    if (!Number.isFinite(bound) || bound <= 0) throw new RangeError("recordWithinMs must be a finite number of milliseconds above zero");
    this.recordWithinMs = bound;
    const readBound = options.readWithinMs ?? JudgeEventHandler.DEFAULT_READ_WITHIN_MS;
    if (!Number.isFinite(readBound) || readBound <= 0) throw new RangeError("readWithinMs must be a finite number of milliseconds above zero");
    this.readWithinMs = readBound;
    const { shellCommandReader, projectRoot } = options;
    if (shellCommandReader !== undefined && projectRoot === undefined) throw new RangeError("a shell command reader needs the project's root");
    this.reader = shellCommandReader === undefined || projectRoot === undefined ? undefined : { shellCommandReader, projectRoot };
    this.ids = options.ids ?? defaultDecisionIds;
    this.beforeAllow = options.beforeAllow;
    const refusal = options.refuseEverything ?? (composition === null ? NO_COMPOSITION : undefined);
    this.decidesByGuards = refusal === undefined && composition !== null;
    if (refusal !== undefined || composition === null) this.decide = () => ({ verdict: refusal ?? NO_COMPOSITION, refusedBy: null });
    else this.decide = (event) => decideEvent(composition, event);
  }

  async execute(command: JudgeEventCommand): Promise<Verdict> {
    try {
      const event = await this.withReadings(command.event);
      const judgement = await this.judged(event);
      return await this.settle(judgement, () => Decision.of(nextDecisionId(this.ids), this.now(), event, judgement));
    } catch (thrown) {
      return Verdict.refuse(`Judging could not finish: ${text(thrown)}`, "Report this to the maintainers of bounded; the action is refused meanwhile");
    }
  }

  /**
   * The event with every execute effect carrying the project's reading of its
   * command (ADR 2026-020), rebuilt through ToolUse.parse: a reading the host
   * sent is replaced, never trusted. Commands are read all at once, within
   * readWithinMs for the whole event.
   */
  private async withReadings(event: Event): Promise<Event> {
    if (event.kind !== "tool-use" || !this.decidesByGuards) return event;
    const executes = event.effects.flatMap((effect, index) => (effect.kind === "execute" ? [{ index, effect }] : []));
    if (executes.length === 0) return event;
    const readings = await this.readings(executes.map(({ effect }) => effect));
    const wire = event.toJSON();
    const effects = wire.effects.map((effect, index) => {
      const at = executes.findIndex((execute) => execute.index === index);
      const reading = readings[at];
      return reading === undefined ? effect : { ...effect, reading: reading.toJSON() };
    });
    const rebuilt = ToolUse.parse({ ...wire, effects });
    if (!rebuilt.ok) throw new Error(`the event could not carry its commands' readings: ${rebuilt.error}`);
    return rebuilt.value;
  }

  /** Each command's reading, in order; never rejects. */
  private async readings(executes: readonly ExecuteEffect[]): Promise<readonly ShellCommandReading[]> {
    const { reader } = this;
    if (reader === undefined) return executes.map(() => unread(NO_READER));
    const read: (ShellCommandReading | undefined)[] = executes.map(() => undefined);
    const all = Promise.all(
      executes.map(async (effect, index) => {
        read[index] = await readingOf(reader.shellCommandReader, reader.projectRoot, effect);
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.readWithinMs);
    });
    try {
      await Promise.race([all, late]);
    } finally {
      clearTimeout(timer);
    }
    return read.map((reading) => reading ?? unread(`reading the command did not finish within ${this.readWithinMs} ms (timed out)`));
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
      const command = JudgeEventCommandFactory.parse(raw);
      if (command.ok) return await this.execute(command.value);
      const refusal = Verdict.refuse(`The host sent an event that cannot be read: ${command.error}`, "Report this to the maintainers of the host adapter; the action is refused meanwhile");
      return await this.settle({ verdict: refusal, refusedBy: null }, () => Decision.invalid(nextDecisionId(this.ids), this.now(), refusal));
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
      const parsed = AdapterRefusal.parse(refusal);
      if (!parsed.ok) throw new Error(parsed.error);
      const adapterRefusal = parsed.value;
      return await this.settle({ verdict: adapterRefusal.verdict, refusedBy: null }, () => Decision.adapter(nextDecisionId(this.ids), this.now(), adapterRefusal));
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

  /** The time of a decision. What the clock gives is parsed again: a host's clock is unchecked at run time, so ISO 8601 text is accepted with the same check. */
  private now(): string {
    const time: unknown = this.clock.now();
    const parsed = DecisionTime.parse(time);
    if (!parsed.ok) throw new Error(`the clock gave '${text(time)}', not an ISO 8601 time`);
    return parsed.value.value;
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
