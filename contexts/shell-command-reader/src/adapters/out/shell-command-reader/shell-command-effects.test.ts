import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Command, ProjectPath } from "bounded/domain";
import type { PathKind } from "../../../domain/shell-command.contract.ts";
import { WORK_BUDGET_STEPS } from "../../../domain/command-meanings.ts";
import { describeShellCommand } from "../../../domain/shell-command.ts";
import { type BashSyntaxTree, bashSyntaxTree } from "./bash-syntax-tree.ts";

// What the reader makes of a command before it becomes a reading: tree-sitter's
// bash syntax tree (bash-syntax-tree.ts), translated by describeShellCommand
// into the paths it reads, lists and writes.

/** The project root the commands are described in. */
const ROOT = "/work/project";
/** What a test says is at a path: a kind, or "unknown" when it cannot be told. */
type PathsForTest = Readonly<Record<string, PathKind | "unknown">>;

let parser: BashSyntaxTree;
beforeAll(async () => {
  parser = await bashSyntaxTree();
});

/** A value object from its wire form, as the core makes them. */
function made<T>(parsed: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
const commandOf = (text: string): Command => made(Command.parse(text));

/** What is at a path, as `paths` gives it: undefined where given as unknown, else a directory for the root, else nothing. */
const kindOf =
  (paths: PathsForTest) =>
  ({ value: path }: ProjectPath): PathKind | undefined => {
    const given = Object.hasOwn(paths, path) ? paths[path] : undefined;
    if (given === "unknown") return undefined;
    return given ?? (path === "." ? "directory" : "absent");
  };

/** What `command` reads, lists and writes from `cwd`, with `paths` saying what exists; paths as text, unresolved parts by their text. */
function described(command: string, cwd: string | null = null, paths: PathsForTest = {}) {
  const script = made(parser.parse(commandOf(command)));
  const parseScript = (text: string) => {
    const nested = Command.parse(text);
    return nested.ok ? parser.parse(nested.value) : nested;
  };
  const effects = describeShellCommand(script, { cwd: cwd === null ? null : made(ProjectPath.parse(cwd)), root: ROOT, kindOfPath: kindOf(paths), parseScript });
  return {
    reads: effects.reads.map((path) => path.value),
    lists: effects.lists.map((path) => path.value),
    writes: effects.writes.map((write) => ({ ...write, path: write.path.value })),
    unresolved: effects.unresolved.map((part) => part.text),
  };
}

describe("read by bounded's shell command reader — describeShellCommand: a parsed command as the paths it reads and writes, deciding nothing", () => {
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
      reads: ["b.txt"],
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

describe("read by bounded's shell command reader — describeShellCommand: braces, nested shells and repository paths, as the shell reads them", () => {
  test("brace expansion of literals gives each word; braces inside quotes are text", () => {
    expect(described("cat {.env,x} a{1..3}b '{q,r}' \"{s,t}\"").reads).toEqual([".env", "x", "a1b", "a2b", "a3b", "{q,r}", "{s,t}"]);
    expect(described("cat a{c..e}").reads).toEqual(["ac", "ad", "ae"]);
    expect(described("cat {1..100000}").reads).toEqual([]);
  });

  test("a shell given code with -c runs it as a nested command line, in a shell of its own", () => {
    expect(described("bash -c 'cat a.txt'").reads).toEqual(["a.txt"]);
    expect(described('sh -c "cd sub && cat ../b.txt" name arg').reads).toEqual(["b.txt"]);
    expect(described("bash -lc 'cd sub'; cat c.txt").reads).toEqual(["c.txt"]);
    expect(described("bash script.sh").reads).toEqual(["script.sh"]);
  });

  test("git's <rev>:<path> reads the path from the repository root, or from where it runs with ./; unresolved without a repository at the root", () => {
    expect(described("git show HEAD:.env", "sub", { ".git": "directory" }).reads).toContain(".env");
    expect(described("git show HEAD:./x.txt", "sub", { ".git": "directory" }).reads).toContain("sub/x.txt");
    expect(described("git show HEAD:.env").unresolved).toContain("HEAD:.env");
  });

  test("git -C dir runs git from dir, nested -C from the one before; a dir only the shell can resolve leaves its paths unresolved", () => {
    expect(described("git -C sub diff x", "app")).toEqual({ reads: ["app/sub/x"], lists: [], writes: [], unresolved: [] });
    expect(described("git -C sub -C deeper diff x").reads).toEqual(["sub/deeper/x"]);
    expect(described("git -C sub rm x").writes).toEqual([{ path: "sub/x", change: "delete" }]);
    expect(described('git -C "$X" diff secret')).toEqual({ reads: [], lists: [], writes: [], unresolved: ['"$X"', "secret"] });
  });

  test("git's global options that take a separate value word (--config-env, --attr-source) skip it, so a later -C is still found", () => {
    expect(described("git --config-env a=B -C sub rm x").writes).toEqual([{ path: "sub/x", change: "delete" }]);
    expect(described("git --attr-source HEAD -C sub rm x").writes).toEqual([{ path: "sub/x", change: "delete" }]);
  });

  test("a short option's attached value is read for every way it could be one (-rf.env reads f.env and .env); a known option's attached value is that option's", () => {
    expect(described("grep -f.env x").reads).toEqual([".env", "x"]);
    expect(described("grep -rf.env x").reads).toEqual(["f.env", ".env", "x"]);
    expect(described("xargs -a.env echo").reads).toEqual([".env"]);
    expect(described("cp -tsub a.txt", null, { sub: "directory" }).writes).toEqual([{ path: "sub/a.txt", change: "create" }]);
    expect(described("mv --target-directory=sub a.txt", null, { sub: "directory" }).writes).toContainEqual({ path: "sub/a.txt", change: "create" });
  });

  test("ANSI-C strings with simple escapes are literal, others unresolved; $(< file) reads the file", () => {
    expect(described("cat $'a.txt' $'it\\'s.txt'").reads).toEqual(["a.txt", "it's.txt"]);
    expect(described("cat $'\\x2eenv'").unresolved).toEqual(["$'\\x2eenv'"]);
    expect(described("echo $(< f.txt)").reads).toEqual(["f.txt"]);
  });
});

describe("read by bounded's shell command reader — treeSitterShellParser: the shell parser behind the port", () => {
  test("gives commands with their words, redirections, lists, pipelines, subshells, groups and substitutions", () => {
    const script = parser.parse(commandOf("(cd a); { cat b; } | wc && echo `x` > o"));
    expect(script.ok).toBe(true);
    if (!script.ok) return;
    expect(script.value.map((node) => node.kind)[0]).toBe("subshell");
    expect(script.value.length).toBe(2);
  });

  test("quoted and escaped words are literal; expansions, globs and home are unresolved, with the commands inside them", () => {
    const script = parser.parse(commandOf("cat \"a b\" 'c' d\\ e $X *.ts ~/f \"$(cat g)\""));
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

describe("the bash syntax tree: a redirection after a list or a pipeline is its last command's", () => {
  test("the grammar hangs it on the whole list; the shell gives it to the last command, which runs where the list took it", () => {
    expect(described("cd sub && echo x > out.txt", null, { sub: "directory" }).writes).toEqual([{ path: "sub/out.txt", change: "create" }]);
    expect(described("cd sub || echo x > out.txt", null, { sub: "directory" }).writes).toEqual([{ path: "out.txt", change: "create" }]);
    expect(described("echo x | tee a.txt > b.txt").writes).toEqual([
      { path: "a.txt", change: "create" },
      { path: "b.txt", change: "create" },
    ]);
    expect(described("{ cd sub; echo x; } > out.txt", null, { sub: "directory" }).writes).toEqual([{ path: "out.txt", change: "create" }]);
  });
});

describe("the work budget: what reading a command costs", () => {
  /** The steps reading `command` takes, and whether it ran out. */
  const cost = (command: string) => {
    const script = made(parser.parse(commandOf(command)));
    const effects = describeShellCommand(script, { cwd: null, root: ROOT, kindOfPath: kindOf({}), parseScript: () => ({ ok: false, error: "no nested shell" }) });
    return { workSpent: effects.workSpent, unread: effects.unreadWhy !== undefined };
  };

  test("a realistic 500-line install script takes a small part of the budget", async () => {
    const script = await Bun.file(join(import.meta.dir, "../../../../test/fixtures/install.sh")).text();
    const spent = cost(script);
    expect(spent.unread).toBe(false);
    expect(spent.workSpent).toBeGreaterThan(1000);
    expect(spent.workSpent).toBeLessThan(WORK_BUDGET_STEPS / 10);
  });

  test("the domain asks the time it is given, and once it has run out the command is unread", () => {
    const script = made(parser.parse(commandOf("cat a.txt; rm b.txt")));
    const place = { cwd: null, root: ROOT, kindOfPath: kindOf({}), parseScript: () => ({ ok: false as const, error: "no nested shell" }) };
    expect(describeShellCommand(script, { ...place, outOfTime: () => true }).unreadWhy).toBe("the command is too complex to read within the time bounded allows for one command");
    expect(describeShellCommand(script, { ...place, outOfTime: () => false }).unreadWhy).toBeUndefined();
  });

  test("the budget counts work, not calls: a word costs a step each time it is handled", () => {
    const few = cost(`cat ${"a ".repeat(10)}`).workSpent;
    const many = cost(`cat ${"a ".repeat(1000)}`).workSpent;
    expect(many).toBeGreaterThan(few * 50);
    expect(cost(`${"xargs $A ".repeat(24)}true ${"w ".repeat(5000)}`)).toMatchObject({ unread: true });
  });
});
