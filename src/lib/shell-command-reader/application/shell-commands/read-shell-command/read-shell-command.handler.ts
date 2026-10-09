import { ShellCommandReading, type ShellCommandReadingJSON } from "bounded/domain";
import { ReadShellCommandCommand } from "./read-shell-command.command.ts";
import type { ReadShellCommand, ReadShellCommandOptions, ShellCommandReader } from "./read-shell-command.contract.ts";

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

/** `work`'s promise; a synchronous throw becomes its rejection, so a reader that throws is handled as one that rejects. */
function attempt<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(work()));
}

/** The wire form of an unread reading saying `why`; one whose why cannot be used says so instead. */
function unread(why: string): ShellCommandReadingJSON {
  const reading = ShellCommandReading.parse({ outcome: "unread", why });
  if (reading.ok) return reading.value.toJSON();
  return { outcome: "unread", why: "the shell command reader failed without saying why" };
}

/** A bound in milliseconds: the given one, or the default; anything but a finite number above zero is refused. */
function boundOf(name: string, given: number | undefined, fallback: number): number {
  const bound = given ?? fallback;
  if (!Number.isFinite(bound) || bound <= 0) throw new RangeError(`${name} must be a finite number of milliseconds above zero`);
  return bound;
}

/** Settles when `work` does or when `ms` have passed, whichever is first; `late` is what it gives then. Never rejects when `work` does not. */
async function within<T>(work: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads shell commands for a host adapter with a ShellCommandReader (ADR
 * 2026-020): each command checked, read within readWithinMs, and the
 * reader's answer parsed into a reading's wire form. A command that cannot
 * be read is unread, saying why; nothing here ever rejects. A read started
 * while the reader's preparation is in flight waits for it, up to
 * prepareWithinMs, before its own bound starts.
 */
export class ReadShellCommandHandler implements ReadShellCommand {
  /** How long the reader may take over one command. */
  static readonly DEFAULT_READ_WITHIN_MS = 2000;
  /** How long a read waits for a preparation in flight: the packs' own bound for their work when a project opens. */
  static readonly DEFAULT_PREPARE_WITHIN_MS = 5000;
  private readonly readWithinMs: number;
  private readonly prepareWithinMs: number;
  /** The reader's preparation, once started; it never rejects. */
  private preparing: Promise<void> | undefined;

  constructor(
    private readonly reader: ShellCommandReader,
    options: ReadShellCommandOptions = {},
  ) {
    this.readWithinMs = boundOf("readWithinMs", options.readWithinMs, ReadShellCommandHandler.DEFAULT_READ_WITHIN_MS);
    this.prepareWithinMs = boundOf("prepareWithinMs", options.prepareWithinMs, ReadShellCommandHandler.DEFAULT_PREPARE_WITHIN_MS);
  }

  /** Starts the reader's preparation once; a preparation that fails, throws or never settles is let go: reading works unprepared, or says why it cannot. */
  prepare(): Promise<void> {
    if (this.preparing === undefined) {
      this.preparing = attempt(() => this.reader.prepare()).then(
        () => undefined,
        () => undefined,
      );
    }
    return this.preparing;
  }

  async read(input: unknown): Promise<ShellCommandReadingJSON> {
    try {
      const command = ReadShellCommandCommand.parse(input);
      if (!command.ok) return unread(command.error);
      if (this.preparing !== undefined) await within(this.preparing, this.prepareWithinMs, undefined);
      const { projectRoot, command: shellCommand, cwd } = command.value;
      const timedOut = Symbol("timed out");
      const answer = await within(
        attempt(() => this.reader.read(projectRoot, shellCommand, cwd)),
        this.readWithinMs,
        timedOut,
      );
      if (answer === timedOut) return unread(`reading the command did not finish within ${this.readWithinMs} ms (timed out)`);
      const reading = ShellCommandReading.parse(answer);
      return reading.ok ? reading.value.toJSON() : unread(`the shell command reader gave a reading that cannot be used: ${reading.error}`);
    } catch (thrown) {
      return unread(text(thrown));
    }
  }
}
