// Sample readings for the core's own tests, which cannot depend on the real
// reader (bounded-shell-command-reader, a context of its own, ADR 2026-020):
// what a host adapter would put on an execute effect it read.

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
