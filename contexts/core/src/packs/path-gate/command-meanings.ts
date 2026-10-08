import type { CommandMeaning } from "./command-meanings.contract.ts";
import type { ShellWord } from "./shell-command.contract.ts";

// What a command does with its arguments: a small table, kept explicit. A
// command not in it reads every operand and every long option's value (the
// conservative default). Short options with an attached value (grep -f.env)
// are not read: a known gap.

const NONE: CommandMeaning = Object.freeze({ reads: [], lists: [], writes: [], transfers: [], runs: [], scripts: [], repositoryReads: [], unresolved: [] });
const literalWord = (text: string): ShellWord => ({ kind: "literal", text });
const meaning = (part: Partial<CommandMeaning>): CommandMeaning => ({ ...NONE, ...part });
const literal = (word: ShellWord | undefined): string | undefined => (word?.kind === "literal" ? word.text : undefined);
const here: ShellWord = Object.freeze({ kind: "literal", text: "." });

/** Whether a word is an option: literal, starting with '-', and not '-' alone. */
const isOption = (word: ShellWord): boolean => {
  const text = literal(word);
  return text?.startsWith("-") === true && text !== "-";
};

/** The operands among `args`: every word that is not an option, and every word after '--'. */
function operands(args: readonly ShellWord[]): ShellWord[] {
  const out: ShellWord[] = [];
  let options = true;
  for (const word of args) {
    if (options && literal(word) === "--") options = false;
    else if (!options || !isOption(word)) out.push(word);
  }
  return out;
}

/** The default: every operand, and the value of every `--option=value`, in order. */
function readsOf(args: readonly ShellWord[]): ShellWord[] {
  const out: ShellWord[] = [];
  let options = true;
  for (const word of args) {
    const text = literal(word);
    if (options && text === "--") options = false;
    else if (options && text?.startsWith("--") && text.includes("=")) out.push({ kind: "literal", text: text.slice(text.indexOf("=") + 1) });
    else if (!options || !isOption(word)) out.push(word);
  }
  return out;
}

/** cp and mv: sources and a destination, from `-t dir` or the last operand. */
function transfer(args: readonly ShellWord[], moves: boolean): CommandMeaning {
  let target: ShellWord | undefined;
  const rest: ShellWord[] = [];
  for (let index = 0; index < args.length; index++) {
    const text = literal(args[index]);
    if (text === "-t" || text === "--target-directory") target = args[++index];
    else if (text?.startsWith("--target-directory=")) target = { kind: "literal", text: text.slice(text.indexOf("=") + 1) };
    else rest.push(args[index] as ShellWord);
  }
  const named = operands(rest);
  const destination = target ?? named.at(-1);
  const sources = target === undefined ? named.slice(0, -1) : named;
  if (destination === undefined || sources.length === 0) return meaning({ reads: named });
  return meaning({ transfers: [{ sources, destination, moves }] });
}

/** The command a wrapper runs: its words after the wrapper's own options. */
function runs(args: readonly ShellWord[], optionsWithValues: readonly string[] = []): CommandMeaning {
  for (let index = 0; index < args.length; index++) {
    const word = args[index] as ShellWord;
    const text = literal(word);
    if (text === "--") return run(args.slice(index + 1));
    if (text !== undefined && optionsWithValues.includes(text)) index++;
    else if (!isOption(word)) return run(args.slice(index));
  }
  return NONE;
}
const run = (words: readonly ShellWord[]): CommandMeaning => {
  const [name, ...args] = words;
  return name === undefined ? NONE : meaning({ runs: [{ name, args }] });
};

/** cd and pushd: to their operand, or nowhere known (no operand, '-', or a stack position). */
function moves(args: readonly ShellWord[]): CommandMeaning {
  const [to] = operands(args);
  const text = literal(to);
  return meaning({ location: { to: to === undefined || text === "-" || /^[+-]\d+$/.test(text ?? "") ? null : to } });
}

/** find: its leading operands are listed (where it runs when none); -exec and its kin run a command. */
function find(args: readonly ShellWord[]): CommandMeaning {
  const roots: ShellWord[] = [];
  let index = 0;
  for (; index < args.length; index++) {
    const text = literal(args[index]);
    if (text !== undefined && (text.startsWith("-") || text === "(" || text === "!")) break;
    roots.push(args[index] as ShellWord);
  }
  const ran: { name: ShellWord; args: ShellWord[] }[] = [];
  for (; index < args.length; index++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(literal(args[index]) ?? "")) continue;
    const words: ShellWord[] = [];
    for (index++; index < args.length && ![";", "+"].includes(literal(args[index]) ?? ""); index++) words.push(args[index] as ShellWord);
    const [name, ...rest] = words;
    if (name !== undefined) ran.push({ name, args: rest });
  }
  return meaning({ lists: roots.length === 0 ? [here] : roots, runs: ran });
}

/** git: what its subcommand does with its operands; paths given relative to `-C dir` are unresolved. */
function git(args: readonly ShellWord[]): CommandMeaning {
  let index = 0;
  let elsewhere = false;
  for (; index < args.length; index++) {
    const text = literal(args[index]);
    if (text === "-C") {
      elsewhere = true;
      index++;
    } else if (text === "-c" || text === "--git-dir" || text === "--work-tree" || text === "--namespace") index++;
    else if (text === undefined || !text.startsWith("-")) break;
  }
  const subcommand = literal(args[index]);
  const rest = args.slice(index + 1);
  if (elsewhere) return meaning({ unresolved: operands(rest) });
  // <rev>:<path> names a path in the repository (git show HEAD:.env, git cat-file -p :.env).
  const repositoryReads = operands(rest).filter((operand) => {
    const text = literal(operand);
    return text?.includes(":") === true && !text.includes("://");
  });
  if (subcommand === "add" || subcommand === "stage") return NONE;
  if (subcommand === "rm") return rest.some((word) => literal(word) === "--cached") ? NONE : meaning({ writes: operands(rest).map((word) => ({ word, change: "delete" as const })) });
  if (subcommand === "mv") return transfer(rest, true);
  return meaning({ reads: readsOf(rest), repositoryReads });
}

/** A shell: with -c, its first operand is code it runs; else it reads the script it is given. */
function shell(args: readonly ShellWord[]): CommandMeaning {
  let runsCode = false;
  const rest: ShellWord[] = [];
  for (let index = 0; index < args.length; index++) {
    const text = literal(args[index]);
    if (text === "-o" || text === "+o" || text === "-O" || text === "+O") index++;
    else if (text !== undefined && /^[-+][a-zA-Z]+$/.test(text)) runsCode ||= text.includes("c");
    else if (text?.startsWith("--") !== true) rest.push(args[index] as ShellWord);
  }
  const [first] = rest;
  if (first === undefined) return NONE;
  return runsCode ? meaning({ scripts: [first] }) : meaning({ reads: [first] });
}

/** dd: if= is read, of= is written; its other operands are settings. */
function dd(args: readonly ShellWord[]): CommandMeaning {
  const valued = (key: string) => args.flatMap((arg) => (literal(arg)?.startsWith(key) === true ? [literalWord((literal(arg) ?? "").slice(key.length))] : []));
  return meaning({ reads: valued("if="), writes: valued("of=").map((target) => ({ word: target, change: "write" as const })) });
}

/** curl: it reads the files its data and upload options name with @ (or -T), writes its -o file; its URLs name no project file. */
function curl(args: readonly ShellWord[]): CommandMeaning {
  const reads: ShellWord[] = [];
  const writes: { word: ShellWord; change: "write" }[] = [];
  const data = ["-d", "--data", "--data-ascii", "--data-binary", "--data-urlencode", "-F", "--form", "--form-string"];
  for (let index = 0; index < args.length; index++) {
    const text = literal(args[index]) ?? "";
    const [option, attached] = text.startsWith("--") ? [text.split("=")[0] ?? text, text.includes("=") ? text.slice(text.indexOf("=") + 1) : undefined] : [text.slice(0, 2), text.length > 2 ? text.slice(2) : undefined];
    if (!data.includes(option) && !["-T", "--upload-file", "-o", "--output"].includes(option)) continue;
    const value = attached ?? literal(args[++index]);
    if (value === undefined) continue;
    if (option === "-T" || option === "--upload-file") reads.push(literalWord(value));
    else if (option === "-o" || option === "--output") writes.push({ word: literalWord(value), change: "write" });
    else if (option !== "--form-string" && value.includes("@")) reads.push(literalWord(value.slice(value.indexOf("@") + 1).split(";")[0] ?? ""));
    else if ((option === "-F" || option === "--form") && value.includes("=<")) reads.push(literalWord(value.slice(value.indexOf("=<") + 2).split(";")[0] ?? ""));
  }
  return meaning({ reads, writes });
}

/** xargs: the command it runs, with the arguments given to it literally (the rest come from its input). */
function xargs(args: readonly ShellWord[]): CommandMeaning {
  const fromFile: ShellWord[] = [];
  for (let index = 0; index < args.length; index++) {
    const text = literal(args[index]);
    if (text === "-a" && args[index + 1] !== undefined) fromFile.push(args[index + 1] as ShellWord);
  }
  const ran = runs(args, ["-I", "-L", "-l", "-n", "-P", "-d", "-E", "-e", "-s", "-a"]);
  return meaning({ ...ran, reads: fromFile });
}

const TEXT = [
  "echo", "printf", "true", "false", ":", "test", "[", "[[", "export", "local", "declare", "readonly", "typeset", "unset", "alias", "unalias",
  "type", "which", "hash", "set", "shopt", "exit", "return", "wait", "jobs", "kill", "sleep", "pwd", "dirs", "history", "help", "shift", "trap",
  "umask", "break", "continue", "read",
];

const TABLE: Readonly<Record<string, (args: readonly ShellWord[]) => CommandMeaning>> = Object.freeze({
  ...Object.fromEntries(TEXT.map((name) => [name, () => NONE])),
  ls: (args) => meaning({ lists: operands(args).length === 0 ? [here] : operands(args) }),
  tree: (args) => meaning({ lists: operands(args).length === 0 ? [here] : operands(args) }),
  find,
  touch: (args) => meaning({ writes: operands(args).map((word) => ({ word, change: "create-if-missing" as const })) }),
  mkdir: (args) => meaning({ writes: operands(args).map((word) => ({ word, change: "create" as const })) }),
  rm: (args) => meaning({ writes: operands(args).map((word) => ({ word, change: "delete" as const })) }),
  rmdir: (args) => meaning({ writes: operands(args).map((word) => ({ word, change: "delete" as const })) }),
  unlink: (args) => meaning({ writes: operands(args).map((word) => ({ word, change: "delete" as const })) }),
  cp: (args) => transfer(args, false),
  mv: (args) => transfer(args, true),
  git,
  sh: shell,
  bash: shell,
  zsh: shell,
  dash: shell,
  ksh: shell,
  tee: (args) => meaning({ writes: operands(args).map((target) => ({ word: target, change: "write" as const })) }),
  dd,
  curl,
  cd: moves,
  pushd: moves,
  popd: () => meaning({ location: { to: null } }),
  builtin: (args) => runs(args),
  exec: (args) => runs(args, ["-a"]),
  command: (args) => (args.some((word) => ["-v", "-V"].includes(literal(word) ?? "")) ? NONE : runs(args)),
  xargs,
  eval: (args) => meaning({ unresolved: args }),
});

/** What the command `name` does with `args`. */
export function commandMeaning(name: string, args: readonly ShellWord[]): CommandMeaning {
  const known = Object.hasOwn(TABLE, name) ? TABLE[name] : undefined;
  return known === undefined ? meaning({ reads: readsOf(args) }) : known(args);
}
