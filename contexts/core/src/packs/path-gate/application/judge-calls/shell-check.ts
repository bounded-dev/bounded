import { Command, type ProjectPath, type Result } from "bounded/domain";
import { describeShellCommand } from "../../domain/shell-command.ts";
import type { PathKinds, ShellCheck, ShellCommandEffects, ShellNode, ShellParser } from "./judge-calls.contract.ts";

const text = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/**
 * A check for the project at `root` (what is at its paths from `pathKinds`), usable at once, and the loading of its parser.
 * While the parser is still loading every command is refused, as timed out
 * (a project opens without waiting forever); if it cannot load, every
 * command is refused, saying why.
 */
export function startShellCheck(parser: ShellParser, root: string, pathKinds: PathKinds): { readonly check: ShellCheck; readonly ready: Promise<void> } {
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
      return { ok: true, value: describeShellCommand(parsed.value, { cwd, root, kindOfPath: (path) => pathKinds.kindOf(path), parseScript }) };
    },
  });
  return { check, ready };
}

/** A check for the project at `root` once its parser has loaded, or failed to. */
export async function prepareShellCheck(parser: ShellParser, root: string, pathKinds: PathKinds): Promise<ShellCheck> {
  const { check, ready } = startShellCheck(parser, root, pathKinds);
  await ready;
  return check;
}
