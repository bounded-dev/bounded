import { Command, type OpenedProject, type ProjectPath, type Result } from "bounded/domain";
import { describeShellCommand } from "./shell-command.ts";
import type { ShellCommandEffects, ShellNode, ShellParser } from "./shell-command.contract.ts";

/** A project's shell check: a command, run from a directory, as what it reads, lists and writes; or why it cannot be told. */
export interface ShellCheck {
  describe(command: Command, cwd: ProjectPath | null): Result<ShellCommandEffects>;
}

const text = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/**
 * A check for `project`, usable at once, and the loading of its parser.
 * While the parser is still loading every command is refused, as timed out
 * (a project opens without waiting forever); if it cannot load, every
 * command is refused, saying why.
 */
export function startShellCheck(parser: ShellParser, project: OpenedProject): { readonly check: ShellCheck; readonly ready: Promise<void> } {
  let state: { readonly kind: "loading" } | { readonly kind: "ready" } | { readonly kind: "failed"; readonly why: string } = { kind: "loading" };
  const ready = Promise.resolve()
    .then(() => parser.prepare())
    .then(
      () => {
        state = { kind: "ready" };
      },
      (thrown: unknown) => {
        state = { kind: "failed", why: text(thrown) };
      },
    );
  const parseScript = (script: string): Result<readonly ShellNode[]> => {
    const command = Command.parse(script);
    return command.ok ? parser.parse(command.value) : command;
  };
  const check: ShellCheck = Object.freeze({
    describe(command: Command, cwd: ProjectPath | null): Result<ShellCommandEffects> {
      if (state.kind === "loading") return { ok: false, error: "bounded's shell parser could not load (it had not finished loading when the project opened: timed out)" };
      if (state.kind === "failed") return { ok: false, error: `bounded's shell parser could not load (${state.why})` };
      const parsed = parser.parse(command);
      if (!parsed.ok) return parsed;
      return { ok: true, value: describeShellCommand(parsed.value, { cwd, root: project.root, kindOfPath: (path) => project.kindOfPath(path), parseScript }) };
    },
  });
  return { check, ready };
}

/** A check for `project` once its parser has loaded, or failed to. */
export async function prepareShellCheck(parser: ShellParser, project: OpenedProject): Promise<ShellCheck> {
  const { check, ready } = startShellCheck(parser, project);
  await ready;
  return check;
}
