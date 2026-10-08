import { beforeAll, describe, expect, test } from "bun:test";
import { contribution, Composition, corePack, definePack, dispatchEvent, packIdsFor, ToolUse } from "bounded/domain";
import { pathGate } from "bounded/path-gate";
import { commandMeaning } from "./command-meanings.ts";
import { describeShellCommand } from "./shell-command.ts";
import type { ShellParser, ShellWord } from "./shell-command.contract.ts";
import { prepareShellCheck } from "./shell-check.ts";
import { treeSitterShellParser } from "./shell-parser.tree-sitter.ts";
import { kindOfPathFor, type PathsForTest, ROOT } from "./shell.test-support.ts";

const parser = treeSitterShellParser();
beforeAll(() => parser.prepare());

/** What `command` reads, lists and writes from `cwd`, with `paths` saying what exists. */
function described(command: string, cwd: string | null = null, paths: PathsForTest = {}) {
  const script = parser.parse(command);
  if (!script.ok) throw new Error(script.error);
  return describeShellCommand(script.value, { cwd, root: ROOT, kindOfPath: kindOfPathFor(paths) });
}

describe("describeShellCommand: a parsed command as the paths it reads and writes, deciding nothing", () => {
  test("arguments are reads, the command's name is not; `>` and `>>` targets are writes and `<` sources reads", () => {
    expect(described("sort a.txt < b.txt > out.txt; echo hi >> log.txt", null, { "log.txt": "file" })).toEqual({
      reads: ["a.txt", "b.txt"],
      lists: [],
      writes: [
        { path: "out.txt", change: "create" },
        { path: "log.txt", change: "modify" },
      ],
      unresolved: [],
    });
  });

  test("paths resolve from the directory given, and from a cd before them; ./ and quotes are gone already", () => {
    expect(described("cd sub && cat ../.env './x y' \"z\"", "app")).toEqual({ reads: ["app/.env", "app/sub/x y", "app/sub/z"], lists: [], writes: [], unresolved: [] });
  });

  test("an option's value is read; a bare option is not a path", () => {
    expect(described("node --env-file=.env -v app.js")).toEqual({ reads: [".env", "app.js"], lists: [], writes: [], unresolved: [] });
  });

  test("what only the shell can resolve is unresolved: the parser's unresolved tokens, variables, home, absolute paths and paths leaving the project", () => {
    expect(described("cat *.env $HOME/x ~/x /etc/x ../../x", "a").unresolved).toEqual(["*.env", "$HOME/x", "~/x", "/etc/x", "../../x"]);
    expect(described("cat *.env $HOME/x ~/x /etc/x ../../x", "a").reads).toEqual([]);
  });

  test("a file-descriptor duplication (2>&1) names no path", () => {
    expect(described("make 2>&1")).toEqual({ reads: [], lists: [], writes: [], unresolved: [] });
  });

  test("listing commands give lists, deleting and moving commands deletes, and an undetermined write says so", () => {
    expect(described("ls docs; find src -name x; rm a.txt; mv b.txt c.txt; echo > d.txt", null, { "b.txt": "file", "d.txt": "unknown" })).toEqual({
      reads: [],
      lists: ["docs", "src"],
      writes: [
        { path: "a.txt", change: "delete" },
        { path: "b.txt", change: "delete" },
        { path: "c.txt", change: "create" },
        { path: "d.txt", change: "create", undetermined: true },
        { path: "d.txt", change: "modify", undetermined: true },
      ],
      unresolved: [],
    });
  });
});

describe("commandMeaning: the small table of what a command does with its arguments", () => {
  const words = (...texts: string[]): ShellWord[] => texts.map((text) => ({ kind: "literal", text }));
  test("a command it does not know reads every operand and every long option's value", () => {
    expect(commandMeaning("mytool", words("-v", "--config=c.json", "a", "--", "-b"))).toMatchObject({ reads: words("c.json", "a", "-b") });
  });
  test("text commands name nothing; ls with no operand lists where it runs", () => {
    expect(commandMeaning("echo", words(".env"))).toMatchObject({ reads: [], lists: [], writes: [] });
    expect(commandMeaning("ls", [])).toMatchObject({ lists: words(".") });
  });
  test("cd and pushd move, popd and an argument-less or dashed cd leave the place unknown", () => {
    expect(commandMeaning("cd", words("sub")).location).toEqual({ to: { kind: "literal", text: "sub" } });
    for (const [name, args] of [["cd", []], ["cd", words("-")], ["popd", []]] as const) expect(commandMeaning(name, [...args]).location).toEqual({ to: null });
  });
});

describe("the shell check: the parser, loaded once when the project opens", () => {
  test("a parser used before it is prepared, or that cannot load, refuses rather than guesses", async () => {
    expect(treeSitterShellParser().parse("ls").ok).toBe(false);
    const failing: ShellParser = { prepare: async () => { throw new Error("main.wasm is missing"); }, parse: () => ({ ok: false, error: "not loaded" }) };
    const check = await prepareShellCheck(failing, { root: ROOT, kindOfPath: () => "absent" });
    expect(check.describe("ls", null)).toEqual({ ok: false, error: "bounded's shell parser could not load (main.wasm is missing)" });
  });

  test("a project the path gate was never opened for refuses shell commands, saying how to open it", () => {
    const all = [corePack, pathGate, definePack({ id: packIdsFor("test-packs")("a"), dependsOn: [pathGate], contributes: [contribution(pathGate.points.protectedPaths, [{ match: ".env", deny: ["read"], redirect: "Ask" }])] })];
    const composed = Composition.compose(all, all);
    const call = ToolUse.parse({ role: null, tool: "shell", effects: [{ kind: "execute", command: "ls", cwd: null }] });
    if (!composed.ok || !call.ok) throw new Error("expected a composition and a call");
    expect(dispatchEvent(composed.value, call.value)).toMatchObject({
      kind: "refuse",
      reason: "bounded/path-gate refused execute `ls`: the path gate cannot check shell commands: this project was not opened with openProject, which prepares the check",
      redirect: "Open the project with openProject (bounded/open-project); shell commands are refused until then",
    });
  });
});

describe("treeSitterShellParser: the shell parser behind the port", () => {
  test("gives commands with their words, redirections, lists, pipelines, subshells, groups and substitutions", () => {
    const script = parser.parse("(cd a); { cat b; } | wc && echo `x` > o");
    expect(script.ok).toBe(true);
    if (!script.ok) return;
    expect(script.value.map((node) => node.kind)[0]).toBe("subshell");
    expect(script.value.length).toBe(2);
  });

  test("quoted and escaped words are literal; expansions, globs and home are unresolved, with the commands inside them", () => {
    const script = parser.parse("cat \"a b\" 'c' d\\ e $X *.ts ~/f \"$(cat g)\"");
    if (!script.ok) throw new Error(script.error);
    const [command] = script.value;
    if (command?.kind !== "command") throw new Error("expected a command");
    expect(command.args.map((word) => [word.kind, word.text])).toEqual([
      ["literal", "a b"],
      ["literal", "c"],
      ["literal", "d e"],
      ["unresolved", "$X"],
      ["unresolved", "*.ts"],
      ["unresolved", "~/f"],
      ["unresolved", '"$(cat g)"'],
    ]);
    const inner = command.args[6];
    expect(inner?.kind === "unresolved" && inner.commands.length).toBe(1);
  });
});
