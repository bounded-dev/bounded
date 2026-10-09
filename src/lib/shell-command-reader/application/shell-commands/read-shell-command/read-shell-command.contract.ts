import type { Command, ProjectPath, Result, ShellCommandReadingJSON } from "bounded/domain";

// Reading a shell command for a host adapter (ADR 2026-020). The host
// adapter, trusted code, translates the model's tool call, the untrusted
// part, into the core's event; for each execute effect it reads the command
// here and puts the reading on the effect. The core checks the reading's
// shape and the packs judge from it.

/** The brand only ReadShellCommandCommand itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const readShellCommandCommandBrand: unique symbol;

// Wire input: what a host adapter sends for one command.
export interface ReadShellCommandInput {
  /** The project's root directory, an absolute path. */
  readonly projectRoot: string;
  /** The command exactly as the model gave it. */
  readonly command: string;
  /** The project directory the command runs in, relative to the root; null for the root itself. */
  readonly cwd: string | null;
}

// Command: the input once checked.
export interface ReadShellCommandCommand {
  readonly __brand: "ReadShellCommandCommand";
  readonly [readShellCommandCommandBrand]: true;
  /** The project's root directory, an absolute path. */
  readonly projectRoot: string;
  readonly command: Command;
  /** The project directory the command runs in; null for the root. */
  readonly cwd: ProjectPath | null;
}

export interface ReadShellCommandCommandFactory {
  parse(raw: unknown): Result<ReadShellCommandCommand>;
}

// In port: what this feature offers.
/**
 * Reads shell commands for a host adapter. Neither method ever rejects: a
 * command that cannot be read is an unread reading saying why, which a pack
 * that needs the reading refuses (fail closed).
 */
export interface ReadShellCommand {
  /** Starts loading what reading needs, once; resolves when that settles, whatever it does. A host need not wait for it. */
  prepare(): Promise<void>;
  /** The reading's wire form for one command given as a ReadShellCommandInput: read, or unread with why. */
  read(input: unknown): Promise<ShellCommandReadingJSON>;
}

/** How a read-shell-command handler is bounded in time. */
export interface ReadShellCommandOptions {
  /** How long the reader may take over one command before it is unread, timed out; 2 seconds by default. */
  readonly readWithinMs?: number;
  /** How long a read waits for a preparation still in flight before its own bound starts; 5 seconds by default. */
  readonly prepareWithinMs?: number;
}

// Out ports: exactly what this feature needs.
/**
 * Reads a shell command: what it runs, the files it reads, lists and writes,
 * and what only the shell could resolve (ADR 2026-020). `read` gives the
 * reading's wire form (a ShellCommandReadingJSON), which ReadShellCommand
 * parses, for `command` run from `cwd` (null: the project root) in the
 * project at `projectRoot`; it rejects when it cannot read at all.
 * `prepare` loads what reading needs; preparing twice is harmless, and
 * `read` works unprepared too. Every adapter runs the suite in
 * read-shell-command.shell-command-reader.test-support.ts, published as
 * bounded/testing/shell-command-reader-conformance.
 * @implementedBy TreeSitterShellCommandReader
 */
export interface ShellCommandReader {
  prepare(): Promise<void>;
  read(projectRoot: string, command: Command, cwd: ProjectPath | null): Promise<unknown>;
}
