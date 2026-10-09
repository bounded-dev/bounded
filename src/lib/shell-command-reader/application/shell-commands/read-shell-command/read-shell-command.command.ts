import type { readShellCommandCommandBrand } from "./read-shell-command.contract.ts";
import { Command, ProjectPath, type Result } from "bounded/domain";
import type * as Contract from "./read-shell-command.contract.ts";

const SHAPE = "A shell command to read is { projectRoot, command, cwd }";
const INVALID_ROOT = "A project root is an absolute directory path, such as /home/me/project";
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;

/** One own field of `raw`, never an inherited one. */
const own = (raw: object, name: string): unknown => (Object.hasOwn(raw, name) ? (raw as Record<string, unknown>)[name] : undefined);

class ReadShellCommandCommandImpl implements Contract.ReadShellCommandCommand {
  declare readonly __brand: "ReadShellCommandCommand";
  declare readonly [readShellCommandCommandBrand]: true;

  private constructor(
    readonly projectRoot: string,
    readonly command: Command,
    readonly cwd: ProjectPath | null,
  ) {
    Object.freeze(this);
  }

  /** The command to read, its project's root and its directory, each checked: the root absolute, the command a Command, the directory a ProjectPath or null. */
  static parse(raw: unknown): Result<ReadShellCommandCommand> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: SHAPE };
    const projectRoot = own(raw, "projectRoot");
    if (typeof projectRoot !== "string" || !ABSOLUTE.test(projectRoot)) return { ok: false, error: INVALID_ROOT };
    const command = Command.parse(own(raw, "command"));
    if (!command.ok) return command;
    const rawCwd = own(raw, "cwd") ?? null;
    const cwd = rawCwd === null ? { ok: true as const, value: null } : ProjectPath.parse(rawCwd);
    if (!cwd.ok) return cwd;
    return { ok: true, value: new ReadShellCommandCommandImpl(projectRoot, command.value, cwd.value) };
  }
}

export type ReadShellCommandCommand = Contract.ReadShellCommandCommand;
export const ReadShellCommandCommand: Contract.ReadShellCommandCommandFactory = ReadShellCommandCommandImpl;
