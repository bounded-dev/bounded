import { describe, expect, test } from "bun:test";
import type { CommandMeaning } from "./command-meanings.contract.ts";
import * as CommandMeanings from "./command-meanings.ts";
import { commandMeaning, newWorkBudget, WORK_BUDGET_STEPS } from "./command-meanings.ts";
import type { ShellWord } from "./shell-command.contract.ts";

/** Each text as a literal word, one for each, so a word at a given place is known to be there. */
const words = <Texts extends string[]>(...texts: Texts): { [Index in keyof Texts]: ShellWord } => texts.map((text): ShellWord => ({ kind: "literal", text })) as { [Index in keyof Texts]: ShellWord };

describe("read by bounded's shell command reader — commandMeaning — what a command's name and words say it does", () => {
  test("cat reads its operands; rm deletes them; touch creates them if missing", () => {
    expect(commandMeaning("cat", words("a.ts"), newWorkBudget()).reads).toEqual(words("a.ts"));
    expect(commandMeaning("rm", words("a.ts"), newWorkBudget()).writes).toEqual([{ word: { kind: "literal", text: "a.ts" }, change: "delete" }]);
    expect(commandMeaning("touch", words("a.ts"), newWorkBudget()).writes).toEqual([{ word: { kind: "literal", text: "a.ts" }, change: "create-if-missing" }]);
  });

  test("a command it does not know is taken to read its operands, and to write nothing", () => {
    expect(commandMeaning("frobnicate", words("a.ts"), newWorkBudget())).toMatchObject({ reads: words("a.ts"), lists: [], writes: [] });
  });
});

describe("read by bounded's shell command reader — commandMeaning: the small table of what a command does with its arguments", () => {
  test("a command it does not know reads every operand and every long option's value", () => {
    expect(commandMeaning("mytool", words("-v", "--config=c.json", "a", "--", "-b"), newWorkBudget())).toMatchObject({ reads: words("c.json", "a", "-b") });
  });
  test("text commands name nothing; ls with no operand lists where it runs", () => {
    expect(commandMeaning("echo", words(".env"), newWorkBudget())).toMatchObject({ reads: [], lists: [], writes: [] });
    expect(commandMeaning("ls", [], newWorkBudget())).toMatchObject({ lists: words(".") });
  });
  test("cd and pushd move, popd and an argument-less or dashed cd leave the place unknown", () => {
    expect(commandMeaning("cd", words("sub"), newWorkBudget()).location).toEqual({ to: { kind: "literal", text: "sub" } });
    for (const [name, args] of [["cd", []], ["cd", words("-")], ["popd", []]] as const) expect(commandMeaning(name, [...args], newWorkBudget()).location).toEqual({ to: null });
  });
});

const unresolvedWord = (text: string): ShellWord => ({ kind: "unresolved", text, commands: [] });
/** A meaning's runs, each written `name [args]`, `+` before an added run, `=` before one that shares the shell, and ` @"dir"` (or ` @null`) after one that sets its directory. */
const runsOf = (meaning: CommandMeaning): string[] =>
  meaning.runs.map((run) => {
    const directory = run.directory === undefined ? "" : run.directory === null ? " @null" : ` @"${run.directory.text}"`;
    return `${run.added === true ? "+" : ""}${run.sharesShell === true ? "=" : ""}${run.name.text} [${run.args.map((word) => word.text).join(", ")}]${directory}`;
  });
/** A budget with only `steps` left. */
const budgetOf = (steps: number) => {
  const budget = newWorkBudget();
  budget.left = steps;
  return budget;
};
const spentOf = (budget: { readonly left: number }): number => WORK_BUDGET_STEPS - budget.left;

describe("commandMeaning — a word only the shell can resolve where a wrapper's, a shell's or git's options are: every plausible reading, each added", () => {
  test("a wrapper gives every run the word could leave, today's first and unmarked, the others marked added", () => {
    for (const name of ["doas", "nice", "nohup", "stdbuf", "ionice"]) {
      expect({ name, runs: runsOf(commandMeaning(name, [unresolvedWord('"$X"'), ...words("rm", "x")], newWorkBudget())) }).toEqual({ name, runs: ['"$X" [rm, x]', "+rm [x]", "+x []"] });
    }
    // sudo and env have a directory option the word may be too: those readings are pinned in the case below.
    for (const name of ["sudo", "env"]) {
      const runs = runsOf(commandMeaning(name, [unresolvedWord('"$OPT"'), ...words("rm", "x")], newWorkBudget()));
      expect({ name, first: runs[0], rest: runs.slice(1) }).toEqual({ name, first: '"$OPT" [rm, x]', rest: expect.arrayContaining(["+rm [x]", "+x []"]) });
    }
    for (const name of ["builtin", "exec", "command"]) {
      expect({ name, runs: runsOf(commandMeaning(name, [unresolvedWord('"$X"'), ...words("rm", "x")], newWorkBudget())) }).toEqual({ name, runs: ['="$X" [rm, x]', "+rm [x]", "+x []"] });
    }
  });

  test("only builtin, command and exec's own reading shares the shell", () => {
    for (const name of ["builtin", "command", "exec"]) expect({ name, runs: runsOf(commandMeaning(name, words("cd", "sub"), newWorkBudget())) }).toEqual({ name, runs: ["=cd [sub]"] });
    for (const name of ["sudo", "env", "xargs"]) expect({ name, runs: runsOf(commandMeaning(name, words("cd", "sub"), newWorkBudget())) }).toEqual({ name, runs: ["cd [sub]"] });
  });

  test("a short cluster ending in a value-taking letter takes the next word, as getopt reads it", () => {
    // The reading before, the value word taken for the command, is kept beside it, added (final review, M2).
    expect(runsOf(commandMeaning("sudo", words("-Eu", "root", "rm", ".env"), newWorkBudget()))).toEqual(["rm [.env]", "+root [rm, .env]"]);
    expect(runsOf(commandMeaning("env", words("-iu", "VAR", "rm", "x"), newWorkBudget()))).toEqual(["rm [x]", "+VAR [rm, x]"]);
    // A value-taking letter before the cluster's end takes the rest of the word.
    expect(runsOf(commandMeaning("sudo", words("-uroot", "rm", "x"), newWorkBudget()))).toEqual(["rm [x]"]);
  });

  test("a directory option the word may be runs the command from the next word's directory, or, attached, from nowhere known", () => {
    expect(runsOf(commandMeaning("sudo", [unresolvedWord('"$D"'), ...words("rm", "x")], newWorkBudget()))).toEqual(['"$D" [rm, x]', "+rm [x]", "+rm [x] @null", "+x []", '+x [] @"rm"']);
    expect(runsOf(commandMeaning("env", [unresolvedWord('"$D"'), ...words("cp", "a", "b")], newWorkBudget()))).toEqual(['"$D" [cp, a, b]', "+cp [a, b]", "+cp [a, b] @null", "+a [b]", '+a [b] @"cp"']);
    expect(runsOf(commandMeaning("git", [unresolvedWord('"$O"'), ...words("sub", "rm", "x")], newWorkBudget()))).toContain('+git [rm, x] @"sub"');
  });

  test("the walk's state is carried into every reading", () => {
    expect(runsOf(commandMeaning("env", [...words("-C", "sub"), unresolvedWord('"$X"'), ...words("rm", "x")], newWorkBudget()))).toContain('+rm [x] @"sub"');
    expect(runsOf(commandMeaning("timeout", [...words("-k", "5"), unresolvedWord('"$T"'), ...words("rm", "x")], newWorkBudget()))).toContain("rm [x]");
  });

  test("wrapper forks are memoised by index, directory and leading count", () => {
    const assignments = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"].map((name) => unresolvedWord(`"${name}=$X"`));
    const args = [...assignments, ...words("node", "app.js")];
    const budget = newWorkBudget();
    const meaning = commandMeaning("env", args, budget);
    // A run for each place the command may start, from each directory a word may name: never one per combination of the words' readings.
    expect(meaning.runs.length).toBeLessThanOrEqual(args.length * args.length);
    expect(runsOf(meaning)).toContain("+node [app.js]");
    expect(budget.exhausted).toBe(false);
    expect(spentOf(budget)).toBeLessThan(10_000);
  });

  test("a value of an option the wrapper knows is taken as written", () => {
    expect(runsOf(commandMeaning("sudo", [...words("-u"), unresolvedWord('"$U"'), ...words("rm", "x")], newWorkBudget()))).toEqual(["rm [x]"]);
  });

  test("env -S's literal string is walked through env itself, with the trailing words; one with quotes, escapes or ${ is not split", () => {
    expect(runsOf(commandMeaning("env", words("-S", "-i rm", "x"), newWorkBudget()))).toContain("+env [-i, rm, x]");
    expect(runsOf(commandMeaning("env", words("-S", "-C sub rm", "x"), newWorkBudget()))).toContain("+env [-C, sub, rm, x]");
    const quoted = runsOf(commandMeaning("env", words("-S", "a 'b c'", "rm", "y"), newWorkBudget()));
    expect(quoted).toContain("+rm [y]");
    expect(quoted.filter((run) => run.startsWith("+env "))).toEqual([]);
  });

  test("a shell's forks are memoised by index and its whole state", () => {
    const budget = newWorkBudget();
    const code = commandMeaning("bash", [...Array.from({ length: 20 }, () => unresolvedWord('"$A"')), ...words("-c", "rm x")], budget);
    expect(code.scripts.filter((word) => word.text === "rm x")).toHaveLength(1);
    expect(budget.exhausted).toBe(false);
    expect(spentOf(budget)).toBeLessThan(20_000);
    // One fork reaches deploy.sh where s may be set, another where it may not: the script is read, and standard input reported, each once.
    const script = commandMeaning("bash", [unresolvedWord('"$A"'), unresolvedWord('"$B"'), ...words("deploy.sh")], newWorkBudget());
    expect(script.reads.filter((word) => word.text === "deploy.sh")).toHaveLength(1);
    expect(script.unresolved.filter((word) => word.text === "(standard input)")).toHaveLength(1);
  });

  test("a fork that reaches no operand reports standard input", () => {
    expect(commandMeaning("bash", [unresolvedWord('"$A"')], newWorkBudget()).unresolved.map((word) => word.text)).toContain("(standard input)");
  });

  test("each reading is charged when it is made", () => {
    // The forty words alone cost 41 steps; their readings cost more than the 59 left.
    const budget = budgetOf(100);
    commandMeaning(
      "sudo",
      Array.from({ length: 40 }, () => unresolvedWord('"$A"')),
      budget,
    );
    expect(budget.exhausted).toBe(true);
  });

  test("one dedupe key, and a merge keeps the run that is not added", () => {
    // Read from the module, so that until it exists this case alone fails.
    const { mergeMeanings } = CommandMeanings;
    const none: CommandMeaning = { reads: [], lists: [], writes: [], transfers: [], runs: [], scripts: [], repositoryReads: [], unresolved: [] };
    const rm = { name: words("rm")[0] as ShellWord, args: words("x"), trailing: true as const };
    const merged = (...meanings: CommandMeaning[]) => mergeMeanings(meanings, newWorkBudget());
    // Equal runs are kept once; of an added one and one that is not, the one that is not.
    expect(merged({ ...none, runs: [{ ...rm, added: true }] }, { ...none, runs: [rm] }).runs).toEqual([rm]);
    expect(merged({ ...none, runs: [rm] }, { ...none, runs: [rm] }).runs).toEqual([rm]);
    // Runs that differ in a word's kind, in a directory absent or null, in trailing or in sharing the shell are kept apart.
    for (const other of [{ ...rm, args: [unresolvedWord("x")] }, { ...rm, directory: null }, { name: rm.name, args: rm.args }, { ...rm, sharesShell: true as const }]) {
      expect(merged({ ...none, runs: [rm] }, { ...none, runs: [other] }).runs).toEqual([rm, other]);
    }
    // Scripts and reads likewise, by kind and text.
    const both = merged({ ...none, scripts: words("rm x"), reads: words("a") }, { ...none, scripts: [...words("rm x"), unresolvedWord("rm x")], reads: [...words("a"), unresolvedWord("a")] });
    expect(both.scripts).toEqual([...words("rm x"), unresolvedWord("rm x")]);
    expect(both.reads).toEqual([...words("a"), unresolvedWord("a")]);
    // Each key is charged: merging a meaning with itself costs at least its repeated keys more than merging it alone (a run of two words, a script, a read).
    const meaning: CommandMeaning = { ...none, runs: [rm], scripts: words("rm x"), reads: words("a") };
    const once = newWorkBudget();
    mergeMeanings([meaning], once);
    const twice = newWorkBudget();
    mergeMeanings([meaning, meaning], twice);
    expect(spentOf(twice) - spentOf(once)).toBeGreaterThanOrEqual(1 + 2 + 1 + 1);
  });
});

/** A meaning's writes, each by its word's text. */
const writesOf = (meaning: CommandMeaning): string[] => meaning.writes.map(({ word }) => word.text);
/** A meaning's unresolved parts, each by its text. */
const unresolvedOf = (meaning: CommandMeaning): string[] => meaning.unresolved.map((word) => word.text);
const WORKING_TREE = "(the working tree)";
const textsOf = (args: readonly ShellWord[]): string[] => args.map((word) => word.text);

describe("commandMeaning — package runners, a program named by its path, common text programs, time, coproc, git's writing subcommands, trap and alias", () => {
  test("package runners run the package's binary, named without its version, after their own options, and keep today's reads", () => {
    const cdktf = commandMeaning("npx", words("-y", "cdktf@0.20", "deploy"), newWorkBudget());
    expect(runsOf(cdktf)).toEqual(["+cdktf [deploy]"]);
    // Today's reading: the runner as a program bounded does not know, reading its operands.
    expect(cdktf.reads).toEqual(words("cdktf@0.20", "deploy"));
    for (const [name, args] of [
      ["pnpx", words("tool", "x")],
      ["bun", words("x", "tool", "x")],
      ["uv", words("tool", "run", "tool", "x")],
      ["npx", words("@scope/tool@1", "x")],
      ["uvx", words("tool", "x")],
      ["bunx", words("tool", "x")],
      ["pnpm", words("exec", "tool", "x")],
      ["yarn", words("dlx", "tool", "x")],
    ] as const) {
      expect({ name, args: textsOf(args), runs: runsOf(commandMeaning(name, args, newWorkBudget())) }).toEqual({ name, args: textsOf(args), runs: ["+tool [x]"] });
    }
    expect(runsOf(commandMeaning("bunx", words("--bun", "vite", "build"), newWorkBudget()))).toEqual(["+vite [build]"]);
    expect(runsOf(commandMeaning("pnpm", words("--dir", "web", "exec", "eslint", "."), newWorkBudget()))).toEqual(['+eslint [.] @"web"']);
    expect(runsOf(commandMeaning("pnpm", words("-r", "exec", "rm", "x"), newWorkBudget()))).toEqual(["+rm [x] @null"]);
    expect(runsOf(commandMeaning("pnpm", words("-w", "exec", "rm", "x"), newWorkBudget()))).toEqual(["+rm [x] @null"]);
    expect(runsOf(commandMeaning("pnpm", words("--filter", "web", "exec", "rm", "x"), newWorkBudget()))).toEqual(["+rm [x] @null"]);
    expect(runsOf(commandMeaning("npx", words("-w", "web", "rm", "x"), newWorkBudget()))).toEqual(["+rm [x] @null"]);
    expect(runsOf(commandMeaning("yarn", words("--cwd", "web", "dlx", "-p", "pkg", "tool", "x"), newWorkBudget()))).toEqual(['+tool [x] @"web"']);
    expect(runsOf(commandMeaning("uvx", [...words("--directory"), unresolvedWord('"$D"'), ...words("x")], newWorkBudget()))).toEqual(["+x [] @null"]);
    for (const [name, args] of [
      ["npx", words("-c", "rm x")],
      ["npx", words("--call", "rm x")],
      ["pnpm", words("exec", "-c", "rm x")],
      ["pnpm", words("exec", "--shell-mode", "rm x")],
    ] as const) {
      expect({ name, args: textsOf(args), scripts: commandMeaning(name, args, newWorkBudget()).scripts }).toEqual({ name, args: textsOf(args), scripts: words("rm x") });
    }
    // Other subcommands of bun, pnpm, yarn and uv run nothing bounded can name: today's reading only.
    for (const [name, args] of [
      ["bun", words("run", "build")],
      ["pnpm", words("install")],
      ["yarn", words("add", "x")],
      ["uv", words("run", "x")],
    ] as const) {
      expect({ name, runs: runsOf(commandMeaning(name, args, newWorkBudget())) }).toEqual({ name, runs: [] });
    }
  });

  test("an unknown runner option forks as xargs's do, memoised and charged", () => {
    const runs = runsOf(commandMeaning("npx", words("--bogus", "rm", "x"), newWorkBudget()));
    expect(runs).toEqual(expect.arrayContaining(["+rm [x]", "+x []"]));
    const bogus = (): ShellWord[] => [...Array.from({ length: 40 }, () => words("--bogus")[0] as ShellWord), ...words("rm", "x")];
    // Forty unknown options: the words alone cost 43 steps; their readings cost more than the 57 left.
    const budget = budgetOf(100);
    commandMeaning("npx", bogus(), budget);
    expect(budget.exhausted).toBe(true);
    // Memoised: within the whole budget, forty unknown options cost at most a step per word left at each.
    const whole = newWorkBudget();
    commandMeaning("npx", bogus(), whole);
    expect(whole.exhausted).toBe(false);
    expect(spentOf(whole)).toBeLessThan(10_000);
  });

  test("a program named by its path or in another case is also the table's program, never moving the shell", () => {
    for (const name of ["/bin/rm", "RM", "./rm", "/usr/local/bin/Rm"]) {
      expect({ name, writes: commandMeaning(name, words("x"), newWorkBudget()).writes }).toEqual({ name, writes: [{ word: words("x")[0], change: "delete" }] });
    }
    // Today's reading is kept beside it: the program as written reads its operands.
    expect(commandMeaning("/bin/rm", words("x"), newWorkBudget()).reads).toEqual(words("x"));
    expect(commandMeaning("/usr/bin/cd", words("sub"), newWorkBudget()).location).toBeUndefined();
    expect(commandMeaning("CD", words("sub"), newWorkBudget()).location).toBeUndefined();
    const command = commandMeaning("/usr/bin/command", words("cd", "sub"), newWorkBudget());
    expect(runsOf(command)).toEqual(["+cd [sub]"]);
    expect(command.runs.some((run) => run.sharesShell === true)).toBe(false);
    expect(runsOf(commandMeaning("/usr/bin/env", words("rm", "x"), newWorkBudget()))).toEqual(["+rm [x]"]);
  });

  test("git's writing subcommands write, every plausible way, with their options read as git reads them", () => {
    // Option lists checked against `git <subcommand> -h` of git 2.54.0 (Apple Git-157).
    const git = (...texts: string[]) => commandMeaning("git", words(...texts), newWorkBudget());
    expect(writesOf(git("checkout", "--", "x"))).toEqual(["x"]);
    expect(writesOf(git("checkout", "x"))).toEqual(expect.arrayContaining(["x", WORKING_TREE]));
    expect(writesOf(git("checkout", "-b", "x"))).toEqual([]);
    expect(writesOf(git("switch", "-c", "x"))).toEqual([]);
    expect(writesOf(git("switch", "main"))).toEqual([WORKING_TREE]);
    expect(writesOf(git("restore", "x"))).toEqual(["x"]);
    expect(writesOf(git("restore", "--staged", "x"))).toEqual([]);
    expect(writesOf(git("restore", "--staged", "--worktree", "x"))).toEqual(["x"]);
    const apply = git("apply", "p.patch");
    expect(apply.reads).toContainEqual(words("p.patch")[0]);
    expect(writesOf(apply)).toEqual([WORKING_TREE]);
    expect(writesOf(git("apply", "--check", "p.patch"))).toEqual([]);
    expect(writesOf(git("apply", "--stat", "--apply", "p.patch"))).toEqual([WORKING_TREE]);
    expect(writesOf(git("stash"))).toEqual([WORKING_TREE]);
    expect(writesOf(git("stash", "pop"))).toEqual([WORKING_TREE]);
    expect(writesOf(git("stash", "-u"))).toEqual([WORKING_TREE]);
    expect(writesOf(git("stash", "list"))).toEqual([]);
    expect(writesOf(git("reset", "--hard"))).toEqual([WORKING_TREE]);
    expect(writesOf(git("reset", "--", "x"))).toEqual([]);
    expect(writesOf(git("reset", "--soft", "HEAD~1"))).toEqual([]);
    expect(git("clone", "https://h/r/repo.git").writes).toEqual([{ word: words("repo")[0], change: "create" }]);
    expect(writesOf(git("clone", "--depth", "1", "https://h/r/x.git"))).toEqual(["x"]);
    expect(writesOf(git("clone", "u", "dir"))).toEqual(["dir"]);
    expect(writesOf(git("clone", "host:path/y.bundle"))).toEqual(["y"]);
    expect(writesOf(git("clone", "https://h/r/repo.git/"))).toEqual(["repo"]);
    expect(writesOf(git("clone", "--bare", "https://h/r/repo"))).toEqual(["repo.git"]);
    // A clone source only the shell can name creates a directory only the shell can name.
    const unnamed = commandMeaning("git", [...words("clone"), unresolvedWord('"$URL"')], newWorkBudget());
    expect(unnamed.writes).toEqual([{ word: unresolvedWord('"$URL"'), change: "create" }]);
    // Today's reads of every operand are kept.
    expect(git("checkout", "--", "x").reads).toContainEqual(words("x")[0]);
    // An unknown option forks: a flag, or one that takes the next word; memoised.
    expect(writesOf(git("checkout", "--bogus", "x"))).toEqual(expect.arrayContaining(["x", WORKING_TREE]));
    const budget = newWorkBudget();
    commandMeaning("git", [...words("checkout"), ...Array.from({ length: 30 }, () => words("--bogus")[0] as ShellWord), ...words("x")], budget);
    expect(budget.exhausted).toBe(false);
    expect(spentOf(budget)).toBeLessThan(10_000);
    // A pathspec or option that can reach more than its literal path also reports the working tree.
    for (const args of [
      ["checkout", "--", "."],
      ["checkout", "--", "*.env"],
      ["restore", ":(glob)**/x"],
      ["stash", "push", "--", "dir"],
      ["checkout", "-f", "main"],
      ["checkout", "-m", "main"],
      ["switch", "--discard-changes", "main"],
      ["checkout", "--force", "x"],
    ]) {
      expect({ args, writes: writesOf(git(...args)) }).toEqual({ args, writes: expect.arrayContaining([WORKING_TREE]) });
    }
  });

  test("time and coproc wrap a command; trap's code and a literal alias value are walked; sudo and doas shells read standard input", () => {
    expect(runsOf(commandMeaning("time", words("rm", "x"), newWorkBudget()))).toEqual(["+rm [x]"]);
    expect(runsOf(commandMeaning("time", words("-p", "rm", "x"), newWorkBudget()))).toEqual(["+rm [x]"]);
    expect(runsOf(commandMeaning("time", words("{", "rm", "x"), newWorkBudget()))).toEqual(["+rm [x]"]);
    const cd = commandMeaning("time", words("cd", "sub"), newWorkBudget());
    expect(runsOf(cd)).toEqual(["+cd [sub]"]);
    expect(unresolvedOf(cd)).toContain("(where time's command moves the shell)");
    expect(unresolvedOf(commandMeaning("time", words("rm", "x"), newWorkBudget()))).toEqual([]);
    expect(writesOf(commandMeaning("/usr/bin/time", words("-o", "out.txt", "rm", "x"), newWorkBudget()))).toContain("out.txt");
    expect(runsOf(commandMeaning("coproc", words("rm", "x"), newWorkBudget()))).toEqual(["+rm [x]"]);
    expect(runsOf(commandMeaning("coproc", words("NAME", "rm", "x"), newWorkBudget()))).toEqual(["+NAME [rm, x]"]);
    for (const args of [words("NAME", "{", "rm", "x"), words("{", "rm", "x")]) {
      const meaning = commandMeaning("coproc", args, newWorkBudget());
      expect({ args: textsOf(args), runs: runsOf(meaning), unresolved: unresolvedOf(meaning) }).toEqual({ args: textsOf(args), runs: ["+rm [x]"], unresolved: ["(coproc's { … } body)"] });
    }
    const trap = commandMeaning("trap", words("rm x", "EXIT"), newWorkBudget());
    expect(trap.scripts).toEqual(words("rm x"));
    expect(trap.scriptsFromNowhereKnown).toEqual(words("rm x"));
    for (const args of [words("-p"), words("-l"), words("INT"), words("-", "INT")]) {
      const meaning = commandMeaning("trap", args, newWorkBudget());
      expect({ args: textsOf(args), scripts: meaning.scripts, unresolved: meaning.unresolved }).toEqual({ args: textsOf(args), scripts: [], unresolved: [] });
    }
    const alias = commandMeaning("alias", words("c=rm x"), newWorkBudget());
    expect(alias.unresolved).toEqual(words("rm x"));
    expect(alias.scriptsFromNowhereKnown).toEqual(words("rm x"));
    expect(commandMeaning("alias", words("-p"), newWorkBudget()).unresolved).toEqual([]);
    for (const [name, args] of [
      ["sudo", words("-s")],
      ["sudo", words("-i")],
      ["sudo", words("--shell")],
      ["sudo", words("-Es")],
      ["sudo", words("-u", "root", "-i")],
      ["doas", words("-s")],
    ] as const) {
      expect({ name, args: textsOf(args), unresolved: unresolvedOf(commandMeaning(name, args, newWorkBudget())) }).toEqual({ name, args: textsOf(args), unresolved: ["(standard input)"] });
    }
    // With a command, the shell runs it: no standard input.
    expect(unresolvedOf(commandMeaning("sudo", words("-s", "rm", "x"), newWorkBudget()))).toEqual([]);
    for (const name of ["source", "."]) {
      const meaning = commandMeaning(name, words("x.sh", "arg"), newWorkBudget());
      expect({ name, reads: meaning.reads, unresolved: meaning.unresolved }).toEqual({ name, reads: words("x.sh", "arg"), unresolved: words("x.sh") });
    }
  });

  test("sudo's long options match by unique prefix, as getopt_long matches them; an ambiguous one is read every way", () => {
    // sudo 1.9.17p2's long options, from `sudo -h`.
    expect(runsOf(commandMeaning("sudo", words("--us", "root", "rm", ".env"), newWorkBudget()))).toEqual(expect.arrayContaining(["+rm [.env]"]));
    expect(runsOf(commandMeaning("sudo", words("--chd", "sub", "rm", "x"), newWorkBudget()))).toEqual(expect.arrayContaining(['+rm [x] @"sub"']));
    // --pr: --preserve-env, --preserve-groups or --prompt: a flag, or a value taken from the next word.
    expect(runsOf(commandMeaning("sudo", words("--pr", "rm", "x"), newWorkBudget()))).toEqual(expect.arrayContaining(["rm [x]", "+x []"]));
    // Today's reading of the abbreviation, as an option that takes nothing, is kept.
    expect(runsOf(commandMeaning("sudo", words("--us", "root", "rm", ".env"), newWorkBudget()))).toEqual(expect.arrayContaining(["root [rm, .env]"]));
  });

  test("the common text programs are table entries that read their file operands, with their file-valued options, writes and rg's --pre", () => {
    // Checked against the --help or usage of the versions on the machine the item was built on: grep 2.6.0-FreeBSD, ripgrep 14.1.1,
    // jq 1.7.1, Apple diff, less 668, sort 2.3-Apple, file 5.41, and macOS's stat, date, uniq, wc, column and base64; GNU's from
    // coreutils' documentation, and yq's (mikefarah, v4), where the machine has none.
    const programs = ["grep", "egrep", "fgrep", "rg", "head", "tail", "sort", "uniq", "wc", "cut", "tr", "jq", "yq", "column", "nl", "less", "more", "diff", "cmp", "comm", "paste", "fold", "fmt", "rev", "tac", "base64", "md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "shasum", "file", "stat", "basename", "dirname", "realpath", "date", "seq"];
    for (const name of programs) {
      const meaning = commandMeaning(name, words("a.txt"), newWorkBudget());
      expect({ name, reads: meaning.reads, unresolved: meaning.unresolved, runs: meaning.runs, writes: meaning.writes }).toEqual({ name, reads: words("a.txt"), unresolved: [], runs: [], writes: [] });
    }
    const reads = (name: string, ...texts: string[]) => commandMeaning(name, words(...texts), newWorkBudget()).reads.map((word) => word.text);
    expect(reads("grep", "-f", "pats.txt", "x", "log.txt")).toEqual(expect.arrayContaining(["pats.txt", "x", "log.txt"]));
    expect(reads("grep", "-e", "x", "log.txt")).toContain("log.txt");
    expect(reads("jq", "--slurpfile", "n", "f.json", ".", "g.json")).toEqual(expect.arrayContaining(["f.json", "g.json"]));
    expect(reads("jq", "--rawfile", "n", "t.txt", ".")).toContain("t.txt");
    expect(reads("jq", "-f", "prog.jq", "d.json")).toEqual(expect.arrayContaining(["prog.jq", "d.json"]));
    expect(reads("diff", "--from-file", "a", "b", "c")).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(reads("wc", "--files0-from=list")).toContain("list");
    expect(reads("file", "-m", "magic", "x")).toEqual(expect.arrayContaining(["magic", "x"]));
    expect(reads("date", "-r", "x")).toContain("x");
    const sort = commandMeaning("sort", words("-o", "out.txt", "in.txt"), newWorkBudget());
    expect(writesOf(sort)).toEqual(["out.txt"]);
    expect(sort.reads).toContainEqual(words("in.txt")[0]);
    // GNU sort takes its options after its operands too.
    expect(writesOf(commandMeaning("sort", words("-u", "in.txt", "-o", "out.txt"), newWorkBudget()))).toEqual(["out.txt"]);
    const uniq = commandMeaning("uniq", words("in", "out"), newWorkBudget());
    expect(writesOf(uniq)).toEqual(["out"]);
    expect(uniq.reads).toContainEqual(words("in")[0]);
    expect(writesOf(commandMeaning("uniq", words("-f", "1", "in"), newWorkBudget()))).toEqual([]);
    expect(writesOf(commandMeaning("yq", words("-i", ".a=1", "c.yaml"), newWorkBudget()))).toEqual(["c.yaml"]);
    expect(writesOf(commandMeaning("less", words("-o", "log", "x"), newWorkBudget()))).toEqual(["log"]);
    expect(writesOf(commandMeaning("base64", words("-i", "in", "-o", "out"), newWorkBudget()))).toEqual(["out"]);
    expect(runsOf(commandMeaning("rg", words("--pre", "pdftotext", "x"), newWorkBudget()))).toEqual(["+pdftotext []"]);
    expect(runsOf(commandMeaning("rg", words("--pre=pdftotext", "x"), newWorkBudget()))).toEqual(["+pdftotext []"]);
    // A word only the shell can resolve is read, as a known program's is, never code.
    const pattern = commandMeaning("grep", [unresolvedWord('"$P"'), ...words("log.txt")], newWorkBudget());
    expect(pattern.reads).toEqual([unresolvedWord('"$P"'), ...words("log.txt")]);
    expect(pattern.unresolved).toEqual([]);
    // As today: printf, true, false and test take text; tee writes its operands.
    for (const name of ["printf", "true", "false", "test"]) expect({ name, reads: commandMeaning(name, words("a.txt"), newWorkBudget()).reads }).toEqual({ name, reads: [] });
    expect(writesOf(commandMeaning("tee", words("x"), newWorkBudget()))).toEqual(["x"]);
  });
});
