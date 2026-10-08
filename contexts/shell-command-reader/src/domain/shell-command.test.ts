import { describe, expect, test } from "bun:test";
import { ProjectPath } from "bounded/domain";
import type { PathKind, ShellNode, ShellPlace, ShellRedirect, ShellWord } from "./shell-command.contract.ts";
import { describeShellCommand } from "./shell-command.ts";

// The translation alone, on syntax trees built by hand: no parser.

const literal = (text: string): ShellWord => ({ kind: "literal", text });
const unresolved = (text: string, commands: readonly ShellNode[] = []): ShellWord => ({ kind: "unresolved", text, commands });
const command = (name: ShellWord | null, args: readonly ShellWord[] = [], redirects: readonly ShellRedirect[] = []): ShellNode => ({ kind: "command", name, args, redirects, assignments: [] });
const and = (left: ShellNode, right: ShellNode): ShellNode => ({ kind: "list", left, operator: "&&", right });

/** A place at the project root (or `cwd`), `kinds` saying what is at a path (the root a directory, anything else absent), and no nested shell. */
function place(kinds: Readonly<Record<string, PathKind>> = {}, cwd: string | null = null): ShellPlace {
  const at = cwd === null ? null : ProjectPath.parse(cwd);
  return {
    cwd: at === null ? null : at.ok ? at.value : null,
    root: "/work/project",
    kindOfPath: ({ value }: ProjectPath) => kinds[value] ?? (value === "." ? "directory" : "absent"),
    parseScript: () => ({ ok: false, error: "no nested shell here" }),
  };
}

const programsOf = (script: readonly ShellNode[], at: ShellPlace = place()) =>
  describeShellCommand(script, at).programs.map((program) => [program.name.text, program.arguments.map((word) => word.text), program.workingDirectory === null ? null : program.workingDirectory.value]);

describe("describeShellCommand — the programs a command runs, and what it could not resolve", () => {
  test("describeShellCommand lists the programs a parsed command runs, with where each runs", () => {
    // cd sub && tool-a x; then a substitution's program, run before the command that uses it.
    const script = [and(command(literal("cd"), [literal("sub")]), command(literal("tool-a"), [literal("x"), unresolved("$(tool-b)", [{ kind: "subshell", body: [command(literal("tool-b"))] }])]))];
    expect(programsOf(script, place({ sub: "directory" }))).toEqual([
      ["cd", ["sub"], "."],
      ["tool-b", [], "sub"],
      ["tool-a", ["x", "$(tool-b)"], "sub"],
    ]);
    // A cd that cannot be resolved leaves where later programs run unknown; a bare assignment runs no program.
    expect(programsOf([and(command(literal("cd"), [unresolved("$DIR")]), command(literal("tool-a")))])).toEqual([
      ["cd", ["$DIR"], "."],
      ["tool-a", [], null],
    ]);
    expect(programsOf([command(null)])).toEqual([]);
    // From the directory the command is given.
    expect(programsOf([command(unresolved("$TOOL"), [literal("x")])], place({ app: "directory" }, "app"))).toEqual([["$TOOL", ["x"], "app"]]);
  });

  test("each unresolved word carries the role it would have had", () => {
    const script: ShellNode[] = [
      command(literal("cat"), [unresolved("$IN")]),
      command(literal("ls"), [unresolved("$DIR")]),
      command(literal("tool-a"), [], [{ operator: ">", target: unresolved("$OUT") }]),
      command(literal("cd"), [unresolved("$WHERE")]),
      command(literal("eval"), [unresolved("$CODE")]),
      { kind: "unparsed", text: "((" },
    ];
    expect(describeShellCommand(script, place()).unresolved).toEqual([
      { text: "$IN", role: "read" },
      { text: "$DIR", role: "list" },
      { text: "$OUT", role: "write" },
      { text: "$WHERE", role: "directory" },
      { text: "$CODE", role: "code" },
      { text: "((", role: "code" },
    ]);
  });
});
