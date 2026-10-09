import { describe, expect, test } from "bun:test";
import type { CommandMeaning } from "./command-meanings.contract.ts";
import * as CommandMeanings from "./command-meanings.ts";
import { commandMeaning, newWorkBudget, WORK_BUDGET_STEPS } from "./command-meanings.ts";
import type { ShellWord } from "./shell-command.contract.ts";

const words = (...texts: string[]): ShellWord[] => texts.map((text) => ({ kind: "literal", text }));

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
    expect(runsOf(commandMeaning("sudo", words("-Eu", "root", "rm", ".env"), newWorkBudget()))).toEqual(["rm [.env]"]);
    expect(runsOf(commandMeaning("env", words("-iu", "VAR", "rm", "x"), newWorkBudget()))).toEqual(["rm [x]"]);
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
