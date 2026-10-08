import type { Command, OpenedProject, ProjectPath, Result } from "bounded/domain";
import { describeShellCommand } from "./shell-command.ts";
import type { ShellCommandEffects, ShellParser } from "./shell-command.contract.ts";

/** A project's shell check: a command, run from a directory, as what it reads, lists and writes; or why it cannot be told. */
export interface ShellCheck {
  describe(command: Command, cwd: ProjectPath | null): Result<ShellCommandEffects>;
}

const text = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/** Prepares `parser` for `project`; if it cannot load, every command is refused, saying why. */
export async function prepareShellCheck(parser: ShellParser, project: OpenedProject): Promise<ShellCheck> {
  let failure: string | undefined;
  try {
    await parser.prepare();
  } catch (thrown) {
    failure = `bounded's shell parser could not load (${text(thrown)})`;
  }
  return Object.freeze({
    describe(command: Command, cwd: ProjectPath | null): Result<ShellCommandEffects> {
      if (failure !== undefined) return { ok: false, error: failure };
      const parsed = parser.parse(command);
      if (!parsed.ok) return parsed;
      return { ok: true, value: describeShellCommand(parsed.value, { cwd, root: project.root, kindOfPath: (path) => project.kindOfPath(path) }) };
    },
  });
}
