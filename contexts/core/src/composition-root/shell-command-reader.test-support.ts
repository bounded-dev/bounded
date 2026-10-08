import type { ShellCommandReader } from "bounded/application";
import { ShellCommandReading } from "bounded/domain";

// A shell command reader for the core's own tests, which cannot depend on the
// real one (bounded-shell-command-reader, a context of its own, ADR 2026-020):
// it gives every command the same reading.

/** The reading of a command that could not be read. */
export const UNREAD_SAMPLE = Object.freeze({ outcome: "unread", why: "the parser could not load" });

/** The reading of a command that runs `program` with `args` from the project root, touching no file bounded can name. */
export const readingOf = (program: string, ...args: string[]) =>
  Object.freeze({
    outcome: "read",
    programs: [{ name: { kind: "literal", text: program }, arguments: args.map((text) => ({ kind: "literal", text })), workingDirectory: "." }],
    fileEffects: [],
    unresolved: [],
  });

/** A reader that answers every command with `answer`, a reading's wire form, checked here so a test cannot pass one the judge would refuse. */
export function fixedShellCommandReader(answer: unknown): ShellCommandReader {
  const checked = ShellCommandReading.parse(answer);
  if (!checked.ok) throw new Error(`fixedShellCommandReader was given a reading that cannot be used: ${checked.error}`);
  const wire = checked.value.toJSON();
  return Object.freeze({ prepare: async () => {}, read: async () => wire });
}
