import type { CommandMeaning } from "./command-meanings.contract.ts";
import type { ShellWord, WorkBudget } from "./shell-command.contract.ts";

// What a command does with its arguments: a small table, kept explicit. A
// command not in it reads every operand and every long option's value (the
// conservative default), and every value a short option could have attached
// (grep -f.env reads .env).

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

/** What handling `words`' text costs beyond a step each: a step per 64 characters. */
export const textCost = (words: readonly ShellWord[]): number => words.reduce((steps, word) => steps + (word.text.length >> 6), 0);

/**
 * What reading a short option cluster for every value it could carry costs
 * (attachedValues gives a suffix per leading letter or digit): the
 * suffixes' total length, a step per 64 characters, so a cluster thousands
 * of letters long spends the budget instead of the time.
 */
function clusterCost(word: ShellWord): number {
  const text = literal(word);
  if (text === undefined || !text.startsWith("-") || text.startsWith("--")) return 0;
  let run = 1;
  while (run + 1 < text.length && /[A-Za-z0-9]/.test(text.charAt(run))) run++;
  // Division, not a shift: the product passes 2^31 for a long cluster, and a shift would wrap it negative.
  return Math.floor(((run - 1) * text.length) / 64);
}

/**
 * The values a short option word could carry attached, not knowing which of
 * its letters takes one: the rest of the word after each leading letter, as
 * getopt reads a cluster (-rf.env is -r -f .env, or -r with f.env): f.env, .env.
 */
function attachedValues(text: string): ShellWord[] {
  const out: ShellWord[] = [];
  for (let index = 2; index < text.length && /[A-Za-z0-9]/.test(text.charAt(index - 1)); index++) out.push(literalWord(text.slice(index)));
  return out;
}

/** The default: every operand, the value of every `--option=value`, and every value a short option could have attached, in order. */
function readsOf(args: readonly ShellWord[]): ShellWord[] {
  const out: ShellWord[] = [];
  let options = true;
  for (const word of args) {
    const text = literal(word);
    if (options && text === "--") options = false;
    else if (options && text?.startsWith("--") && text.includes("=")) out.push({ kind: "literal", text: text.slice(text.indexOf("=") + 1) });
    else if (options && text !== undefined && isOption(word) && !text.startsWith("--")) out.push(...attachedValues(text));
    else if (!options || !isOption(word)) out.push(word);
  }
  return out;
}

/** An option's value given in the same word: `--name=value`, or `-Xvalue` for a short one; undefined when it is not `option`'s. */
function attached(text: string, option: string): string | undefined {
  if (option.startsWith("--")) return text.startsWith(`${option}=`) ? text.slice(option.length + 1) : undefined;
  return text.startsWith(option) && text.length > option.length ? text.slice(option.length) : undefined;
}

/** cp and mv: sources and a destination, from `-t dir` (`-tdir`, `--target-directory=dir`) or the last operand. */
function transfer(args: readonly ShellWord[], moves: boolean): CommandMeaning {
  let target: ShellWord | undefined;
  const rest: ShellWord[] = [];
  for (let index = 0; index < args.length; index++) {
    const text = literal(args[index]);
    const value = text === undefined ? undefined : (attached(text, "-t") ?? attached(text, "--target-directory"));
    if (text === "-t" || text === "--target-directory") target = args[++index];
    else if (value !== undefined) target = literalWord(value);
    else rest.push(args[index] as ShellWord);
  }
  const named = operands(rest);
  const destination = target ?? named.at(-1);
  const sources = target === undefined ? named.slice(0, -1) : named;
  if (destination === undefined || sources.length === 0) return meaning({ reads: named });
  return meaning({ transfers: [{ sources, destination, moves }] });
}

/** A command a command runs, as its meaning gives it. */
type Run = CommandMeaning["runs"][number];

/** A word's key: its kind and its text, so a literal never stands for an unresolved word of the same text. */
const wordKey = (word: ShellWord): string => `${word.kind}:${word.text}`;

/** A run's key: everything that makes it run differently (ADR 2026-020's one dedupe key). */
function runKey(run: Run): string {
  const directory = run.directory === undefined ? "absent" : run.directory === null ? null : wordKey(run.directory);
  return JSON.stringify([
    wordKey(run.name),
    run.args.map(wordKey),
    directory,
    run.trailing === true,
    run.input === true,
    run.replace === undefined ? null : wordKey(run.replace),
    run.replacedBy === undefined ? null : wordKey(run.replacedBy),
    run.sharesShell === true,
  ]);
}

/**
 * `runs` with every repeat dropped, by the one key, each key charged its
 * words and their text; where an added run and one that is not share a key,
 * the one that is not is kept, where the first stood.
 */
function withoutRepeatedRuns(runs: readonly Run[], budget: WorkBudget): Run[] {
  const kept: Run[] = [];
  const at = new Map<string, number>();
  for (const run of runs) {
    const words = [run.name, ...run.args];
    if (!spend(budget, 1 + words.length + textCost(words))) return kept;
    const key = runKey(run);
    const index = at.get(key);
    if (index === undefined) {
      at.set(key, kept.length);
      kept.push(run);
    } else if (kept[index]?.added === true && run.added !== true) kept[index] = run;
  }
  return kept;
}

/** `words` with every repeat (the same kind and text) dropped, each key charged. */
function withoutRepeatedWords(words: readonly ShellWord[], budget: WorkBudget): ShellWord[] {
  const kept: ShellWord[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    if (!spend(budget, 1 + textCost([word]))) return kept;
    const key = wordKey(word);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(word);
  }
  return kept;
}

/**
 * The meanings of every plausible reading of one command as one: each part
 * the union of theirs; runs, scripts, reads and code deduplicated by their
 * keys, charged (ADR 2026-020). Nothing any reading gives is dropped.
 */
export function mergeMeanings(meanings: readonly CommandMeaning[], budget: WorkBudget): CommandMeaning {
  const standardInputUnlessInProject = meanings.flatMap((each) => each.standardInputUnlessInProject ?? []);
  const location = meanings.find((each) => each.location !== undefined)?.location;
  return meaning({
    reads: withoutRepeatedWords(
      meanings.flatMap((each) => each.reads),
      budget,
    ),
    lists: meanings.flatMap((each) => each.lists),
    writes: meanings.flatMap((each) => each.writes),
    transfers: meanings.flatMap((each) => each.transfers),
    runs: withoutRepeatedRuns(
      meanings.flatMap((each) => each.runs),
      budget,
    ),
    scripts: withoutRepeatedWords(
      meanings.flatMap((each) => each.scripts),
      budget,
    ),
    repositoryReads: meanings.flatMap((each) => each.repositoryReads),
    unresolved: withoutRepeatedWords(
      meanings.flatMap((each) => each.unresolved),
      budget,
    ),
    ...(standardInputUnlessInProject.length === 0 ? {} : { standardInputUnlessInProject }),
    ...(location === undefined ? {} : { location }),
  });
}

/**
 * builtin, command and exec: the command they run, their words after their
 * own options, in the same shell (sharesShell). A word only the shell can
 * resolve where their options are is read every way (ADR 2026-020): as the
 * command (today's reading, the one that shares the shell), as an option
 * that gives nothing, or as one that takes the next word; each other
 * reading is added, runs in a copy of the shell's place, and is charged.
 */
function runs(args: readonly ShellWord[], budget: WorkBudget, optionsWithValues: readonly string[] = []): CommandMeaning {
  const ran: Run[] = [];
  const seen = new Set<number>();
  const from = (start: number, added: boolean): void => {
    if (seen.has(start)) return;
    seen.add(start);
    if (!spend(budget, 1 + Math.max(args.length - start, 0))) return;
    const run = (index: number): void => {
      const [name, ...rest] = args.slice(index);
      if (name !== undefined) ran.push({ name, args: rest, trailing: true, ...(added ? { added: true as const } : { sharesShell: true as const }) });
    };
    for (let index = start; index < args.length; index++) {
      const word = args[index] as ShellWord;
      const text = literal(word);
      if (text === undefined) {
        run(index);
        from(index + 1, true);
        from(index + 2, true);
        return;
      }
      if (text === "--" || !isOption(word)) {
        run(text === "--" ? index + 1 : index);
        return;
      }
      if (optionsWithValues.includes(text)) index++;
    }
  };
  from(0, false);
  return meaning({ runs: withoutRepeatedRuns(ran, budget) });
}

/**
 * A wrapper that runs the rest of its words as a command (sudo, env,
 * timeout …): its options are skipped, with the values of those in
 * `withValues`, then its own `leading` operands (timeout's duration) and, when
 * `assignments`, NAME=value words.
 */
interface WrapperOptions {
  readonly leading?: number;
  readonly assignments?: boolean;
  /** Options whose value is the directory the command runs from (env -C, sudo -D). */
  readonly directory?: readonly string[];
  /** Options whose value is a command line of its own (env -S). */
  readonly script?: readonly string[];
  /** The wrapper's own name, when a literal script string is also walked through the wrapper itself (env -S). */
  readonly name?: string;
}

/** The letters of the short options (-u, -C) among `options`. */
const lettersOf = (options: readonly string[]): string =>
  options
    .filter((option) => /^-[^-]$/.test(option))
    .map((option) => option.charAt(1))
    .join("");
/** The long option among `options` that `text` is, alone or with =value. */
const longOptionOf = (options: readonly string[], text: string): string | undefined => options.find((option) => option.startsWith("--") && (text === option || text.startsWith(`${option}=`)));
/** What a script string may hold that splitting it on spaces would read wrongly: quotes, backslashes and ${. */
const NOT_SPLIT = /['"\\]|\$\{/;

/**
 * A wrapper's words, read every way they could be (ADR 2026-020). Its own
 * options are walked as getopt walks them: a short cluster letter by letter,
 * a letter that takes a value taking the rest of its word, or the next word
 * when it ends the cluster (sudo -Eu root, env -iu VAR). A word only the
 * shell can resolve where its options are is read as what today's walk takes
 * it for (the command, or timeout's duration) and also, each an added
 * reading, as a word that gives nothing, as an option that takes the next
 * word and, for a wrapper with a directory option, as that option with its
 * value attached (from nowhere known) or in the next word. Readings are
 * memoised by where they start, the directory and the leading operands
 * left, and each is charged the words left.
 */
function wrapper(withValues: readonly string[], options: WrapperOptions = {}) {
  const valueLetters = lettersOf(withValues);
  const directoryLetters = lettersOf(options.directory ?? []);
  const scriptLetters = lettersOf(options.script ?? []);
  return (args: readonly ShellWord[], budget: WorkBudget): CommandMeaning => {
    const ran: Run[] = [];
    const scripts: ShellWord[] = [];
    const unresolved: ShellWord[] = [];
    const seen = new Set<string>();
    const from = (start: number, directory: ShellWord | null | undefined, leadingLeft: number, added: boolean): void => {
      const key = `${start}/${directory === undefined ? "absent" : directory === null ? "null" : wordKey(directory)}/${leadingLeft}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!spend(budget, 1 + Math.max(args.length - start, 0))) return;
      let leading = leadingLeft;
      let at = directory;
      const marks = () => ({ trailing: true as const, ...(at === undefined ? {} : { directory: at }), ...(added ? { added: true as const } : {}) });
      const run = (index: number): void => {
        const [name, ...rest] = args.slice(index);
        if (name !== undefined) ran.push({ name, args: rest, ...marks() });
      };
      /** A script option's value: the string is code, the words after it handed to it, unresolved; added, they run as a command, and a literal string is walked through the wrapper itself. */
      const script = (code: ShellWord | undefined, after: number): void => {
        if (code === undefined) return;
        const trailing = args.slice(after);
        scripts.push(code);
        unresolved.push(...trailing);
        const [name, ...rest] = trailing;
        if (name !== undefined) ran.push({ name, args: rest, ...marks(), added: true });
        if (options.name !== undefined && code.kind === "literal" && !NOT_SPLIT.test(code.text)) {
          const split = code.text
            .split(/[ \t\n]+/)
            .filter((each) => each !== "")
            .map(literalWord);
          ran.push({ name: literalWord(options.name), args: [...split, ...trailing], ...marks(), added: true });
        }
      };
      for (let index = start; index < args.length; index++) {
        const word = args[index] as ShellWord;
        const text = literal(word);
        if (text === undefined) {
          // Only the shell can resolve it: every way it could be read, today's first.
          if (leading > 0) from(index + 1, at, leading - 1, added);
          else run(index);
          // It gives nothing; or it is the directory option with its value attached, from nowhere known.
          from(index + 1, at, leading, true);
          if (options.directory !== undefined) from(index + 1, null, leading, true);
          // It takes the next word; or it is the directory option, the next word its value.
          from(index + 2, at, leading, true);
          const value = args[index + 1];
          if (options.directory !== undefined && value !== undefined) from(index + 2, value, leading, true);
          return;
        }
        if (text === "--") {
          run(index + 1);
          return;
        }
        if (text.startsWith("--")) {
          const scriptOption = longOptionOf(options.script ?? [], text);
          if (scriptOption !== undefined) {
            if (text === scriptOption) script(args[index + 1], index + 2);
            else script(literalWord(text.slice(scriptOption.length + 1)), index + 1);
            return;
          }
          const directoryOption = longOptionOf(options.directory ?? [], text);
          if (directoryOption !== undefined) at = text === directoryOption ? args[++index] : literalWord(text.slice(directoryOption.length + 1));
          else if (withValues.includes(text)) index++;
          continue;
        }
        if (text.startsWith("-") && text !== "-") {
          // A short cluster, as getopt reads it.
          for (let letter = 1; letter < text.length; letter++) {
            const char = text.charAt(letter);
            if (!valueLetters.includes(char) && !directoryLetters.includes(char) && !scriptLetters.includes(char)) continue;
            const rest = text.slice(letter + 1);
            const value = rest === "" ? args[++index] : literalWord(rest);
            if (scriptLetters.includes(char)) {
              script(value, index + 1);
              return;
            }
            if (directoryLetters.includes(char)) at = value;
            break;
          }
          continue;
        }
        if (options.assignments === true && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) continue;
        if (leading > 0) leading--;
        else {
          run(index);
          return;
        }
      }
    };
    from(0, undefined, options.leading ?? 0, false);
    return meaning({ runs: withoutRepeatedRuns(ran, budget), scripts: withoutRepeatedWords(scripts, budget), unresolved: withoutRepeatedWords(unresolved, budget) });
  };
}

/** cd and pushd: to their operand, or nowhere known (no operand, '-', or a stack position). */
function moves(args: readonly ShellWord[]): CommandMeaning {
  const [to] = operands(args);
  const text = literal(to);
  return meaning({ location: { to: to === undefined || text === "-" || /^[+-]\d+$/.test(text ?? "") ? null : to } });
}

/** The path find -exec's command is given where {} stands, as one word only the run can resolve. */
export const FOUND_PATH: ShellWord = Object.freeze({ kind: "unresolved", text: "(found path)", commands: Object.freeze([]) });
/** find -exec's replace string. */
const FOUND_PATH_REPLACE: ShellWord = Object.freeze({ kind: "literal", text: "{}" });

/** find: its leading operands are listed (where it runs when none); -exec and its kin run a command. */
function find(args: readonly ShellWord[]): CommandMeaning {
  const roots: ShellWord[] = [];
  let index = 0;
  for (; index < args.length; index++) {
    const text = literal(args[index]);
    if (text !== undefined && (text.startsWith("-") || text === "(" || text === "!")) break;
    roots.push(args[index] as ShellWord);
  }
  const ran: { name: ShellWord; args: ShellWord[]; replace: ShellWord; replacedBy: ShellWord }[] = [];
  for (; index < args.length; index++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(literal(args[index]) ?? "")) continue;
    const words: ShellWord[] = [];
    for (index++; index < args.length && ![";", "+"].includes(literal(args[index]) ?? ""); index++) words.push(args[index] as ShellWord);
    const [name, ...rest] = words;
    // {} is a replace string whose stand-in is the path find found: listed and reported where it stands; every word is still judged as written.
    if (name !== undefined) ran.push({ name, args: rest, replace: FOUND_PATH_REPLACE, replacedBy: FOUND_PATH });
  }
  return meaning({ lists: roots.length === 0 ? [here] : roots, runs: ran });
}

/**
 * git: what its subcommand does with its operands. `-C dir` runs the rest
 * from dir, as `cd dir && git …` does (a later -C from the one before), the
 * way env -C runs its command: from nowhere known when dir cannot be resolved.
 * A word only the shell can resolve where its global options are is read
 * every way (ADR 2026-020): as the subcommand (today's reading), and, each
 * added and charged, as an option that gives nothing, one that takes the
 * next word, -C with its directory attached (from nowhere known) or in the
 * next word.
 */
function git(args: readonly ShellWord[], budget: WorkBudget): CommandMeaning {
  const readings: CommandMeaning[] = [];
  const seen = new Set<number>();
  const gitFrom = (directory: ShellWord | null, rest: readonly ShellWord[], added: boolean): CommandMeaning =>
    meaning({ runs: [{ name: literalWord("git"), args: rest, directory, trailing: true, ...(added ? { added: true as const } : {}) }] });
  const from = (start: number, added: boolean): void => {
    if (seen.has(start)) return;
    seen.add(start);
    if (!spend(budget, 1 + Math.max(args.length - start, 0))) return;
    let index = start;
    for (; index < args.length; index++) {
      const text = literal(args[index]);
      if (text === "-C") {
        const directory = args[index + 1];
        if (directory !== undefined) readings.push(gitFrom(directory, args.slice(index + 2), added));
        return;
      }
      if (text === undefined) {
        readings.push(subcommandMeaning(args, index));
        from(index + 1, true);
        from(index + 2, true);
        readings.push(gitFrom(null, args.slice(index + 1), true));
        const directory = args[index + 1];
        if (directory !== undefined) readings.push(gitFrom(directory, args.slice(index + 2), true));
        return;
      }
      // Global options git accepts with their value as the next word (checked against git 2.54).
      if (text === "-c" || text === "--git-dir" || text === "--work-tree" || text === "--namespace" || text === "--config-env" || text === "--attr-source") index++;
      else if (!text.startsWith("-")) break;
    }
    readings.push(subcommandMeaning(args, index));
  };
  from(0, false);
  return readings.length === 1 && readings[0] !== undefined ? readings[0] : mergeMeanings(readings, budget);
}

/** What git's subcommand at `index` does with the words after it. */
function subcommandMeaning(args: readonly ShellWord[], index: number): CommandMeaning {
  const subcommand = literal(args[index]);
  const rest = args.slice(index + 1);
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

/** The code a shell reads from its standard input, as one word only the run can resolve. */
export const STANDARD_INPUT: ShellWord = Object.freeze({ kind: "unresolved", text: "(standard input)", commands: Object.freeze([]) });

/**
 * How a shell's `o` and `O` letters take their values, as recorded from the
 * shells themselves (ADR 2026-020): `next` takes the next whole word and the
 * cluster goes on (bash's o and O, dash's o); `rest` takes the rest of the
 * word, or the next word when it ends the cluster (zsh's and ksh's o);
 * `flag` takes nothing (zsh's O).
 */
type OptionValueReading = "next" | "rest" | "flag";
/** Each shell's readings of o and O, where they are known; any other shell, sh among them, is read every way. */
const SHELL_OPTION_READINGS: Readonly<Record<string, { readonly o: readonly OptionValueReading[]; readonly O: readonly OptionValueReading[] }>> = Object.freeze({
  bash: { o: ["next"], O: ["next"] },
  dash: { o: ["next"], O: ["next", "rest", "flag"] },
  zsh: { o: ["rest"], O: ["flag"] },
  ksh: { o: ["rest"], O: ["next", "rest", "flag"] },
});
const EVERY_READING: readonly OptionValueReading[] = ["next", "rest", "flag"];

/** Where a reading of a shell's options leaves it: its operands start at `from`; whether c and s were given; whether a lone '-' ended the options. */
interface ShellOptionsReading {
  readonly from: number;
  readonly code: boolean;
  readonly standardInput: boolean;
}

/**
 * A shell (sh, bash, zsh, dash, ksh): with c, its first operand is code it
 * runs; else it reads the script it is given. Its options are walked every
 * way the shell named, or any shell when its grammar is not known, could
 * read them (o and O, SHELL_OPTION_READINGS), each reading charged and
 * memoised, and the union judged: code from any reading is parsed, and
 * standard input from any is reported. A reading runs code from its standard
 * input when it has no script, s in a cluster, or a script operand that may
 * be standard input (mayBeStandardInput; one that names no project path
 * counts too, judged where the command runs). A long option bounded does not
 * know, and ksh's -R, may have taken any word: standard input is reported
 * (fail closed). '-' before an operand ends the options, the operand being
 * the script. Every operand is still read as written; a heredoc fed to a
 * shell is not parsed as code.
 */
function shell(name: string, args: readonly ShellWord[], budget: WorkBudget): CommandMeaning {
  const grammar = Object.hasOwn(SHELL_OPTION_READINGS, name) ? SHELL_OPTION_READINGS[name] : undefined;
  const readingsOf = (letter: "o" | "O"): readonly OptionValueReading[] => grammar?.[letter] ?? EVERY_READING;
  let unknownOption = false;
  const startupFiles: ShellWord[] = [];
  const outcomes = new Map<string, ShellOptionsReading>();
  const seen = new Set<string>();

  /** Every reading from word `index`, letter `at` of it (0: the word's start), owing `owed` next words to o and O. */
  const walk = (index: number, at: number, code: boolean, standardInput: boolean, owed: number): void => {
    const key = `${index}/${at}/${code}/${standardInput}/${owed}`;
    if (seen.has(key) || !spend(budget)) return;
    seen.add(key);
    const done = (from: number): void => {
      outcomes.set(`${from}/${code}/${standardInput}`, { from, code, standardInput });
    };
    const text = literal(args[index]);
    if (at > 0 && text !== undefined && at < text.length) {
      const letter = text.charAt(at);
      if (letter === "o" || letter === "O") {
        for (const reading of readingsOf(letter)) {
          if (reading === "next") walk(index, at + 1, code, standardInput, owed + 1);
          else if (reading === "flag") walk(index, at + 1, code, standardInput, owed);
          else walk(index + 1 + owed + (at === text.length - 1 ? 1 : 0), 0, code, standardInput, 0);
        }
        return;
      }
      if (letter === "R") unknownOption = true;
      walk(index, at + 1, code || letter === "c", standardInput || letter === "s", owed);
      return;
    }
    if (at > 0) {
      walk(index + 1 + owed, 0, code, standardInput, 0);
      return;
    }
    if (text === undefined && index < args.length) {
      // A word only the shell can resolve where the options are: the script or code (today's reading), and, each charged the words
      // left, a cluster that may hold c or s, or an option that takes the next word, in every state (ADR 2026-020).
      done(index);
      if (!spend(budget, 1 + args.length - index)) return;
      for (const mayRunCode of [code, true]) {
        for (const mayReadStandardInput of [standardInput, true]) {
          walk(index + 1, 0, mayRunCode, mayReadStandardInput, 0);
          walk(index + 2, 0, mayRunCode, mayReadStandardInput, 0);
        }
      }
    } else if (index >= args.length || text === undefined || !/^[-+]/.test(text)) done(index);
    // '-' before an operand ends the options, the operand being the script; alone, it is the script, standard input.
    else if (text === "-") done(index + 1 < args.length ? index + 1 : index);
    else if (text === "--") done(index + 1);
    else if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      const option = equals === -1 ? text : text.slice(0, equals);
      if (SHELL_FILE_OPTIONS.includes(option)) {
        const value = equals === -1 ? args[index + 1] : literalWord(text.slice(equals + 1));
        if (value !== undefined && !startupFiles.includes(value)) startupFiles.push(value);
        walk(index + (equals === -1 ? 2 : 1), 0, code, standardInput, 0);
      } else {
        if (!SHELL_FLAG_OPTIONS.includes(option)) unknownOption = true;
        walk(index + 1, 0, code, standardInput, 0);
      }
    } else walk(index, 1, code, standardInput, 0);
  };
  walk(0, 0, false, false, 0);

  const scripts: ShellWord[] = [];
  const reads: ShellWord[] = [...startupFiles];
  const maybeStandardInput: ShellWord[] = [];
  let standardInput = unknownOption;
  for (const { from, code, standardInput: given } of outcomes.values()) {
    const first = args[from];
    if (code) {
      if (first !== undefined) scripts.push(first);
      continue;
    }
    if (first === undefined || given || mayBeStandardInput(literal(first))) standardInput = true;
    if (first !== undefined) reads.push(first);
    if (first !== undefined) maybeStandardInput.push(first);
  }
  return meaning({
    scripts: withoutRepeatedWords(scripts, budget),
    reads: withoutRepeatedWords(reads, budget),
    unresolved: standardInput ? [STANDARD_INPUT] : [],
    ...(standardInput ? {} : { standardInputUnlessInProject: withoutRepeatedWords(maybeStandardInput, budget) }),
  });
}

/**
 * A program whose name only the shell can resolve may be a shell ("$SHELL"
 * -c '…'): its words read as a shell's arguments, every way any shell reads
 * its options, charged as a command's words are (ADR 2026-020).
 */
export function shellArgumentsMeaning(args: readonly ShellWord[], budget: WorkBudget): CommandMeaning {
  if (!spend(budget, 1 + args.length + textCost(args))) return NONE;
  return shell("", args, budget);
}

/** bash's long options that take a file as their value (the next word, or =value): it reads that file at startup. */
const SHELL_FILE_OPTIONS: readonly string[] = ["--rcfile", "--init-file"];
/** bash's long options that take no value. */
const SHELL_FLAG_OPTIONS: readonly string[] = ["--debugger", "--dump-po-strings", "--dump-strings", "--help", "--login", "--noediting", "--noprofile", "--norc", "--posix", "--pretty-print", "--restricted", "--verbose", "--version"];

/**
 * Whether a script operand may be the shell's standard input, failing
 * closed: '-'; a path under /dev/ or /proc/ (repeated slashes and '.'
 * segments collapsed: /dev/stdin, /dev/fd/<n>, /proc/self/fd/0, and any
 * other device or process file); a path with a '..' segment, which may
 * climb anywhere; or one starting with '~'. One that names no project path
 * counts too, judged where the command runs (standardInputUnlessInProject).
 */
function mayBeStandardInput(text: string | undefined): boolean {
  if (text === undefined) return false;
  if (text === "-" || text.startsWith("~")) return true;
  const parts = text.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return true;
  return text.startsWith("/") && (parts[0] === "dev" || parts[0] === "proc");
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

/**
 * xargs: the command it runs, with the arguments given to it literally, each
 * judged as written. Without a replace string more arguments come after them
 * from its input; with one (-I, -i, --replace, BSD -J) the input is
 * substituted in place, which is reported, never judged in the words' stead.
 * When which word is its command cannot be told (an unknown or ambiguous
 * long option, a word only the shell can resolve among its options), every
 * plausible reading runs, and the words that follow are also read as
 * operands: the strictest verdict wins, and nothing leaves judgement.
 */
function xargs(args: readonly ShellWord[], budget: WorkBudget): CommandMeaning {
  const ran: Run[] = [];
  const reads: ShellWord[] = [];
  for (const reading of xargsReadings(args, 0, { replace: undefined, argFiles: [] }, budget)) {
    reads.push(...reading.argFiles, ...reading.operands);
    const [name, ...rest] = reading.command;
    if (name !== undefined) ran.push({ name, args: rest, ...(reading.replace === undefined ? { input: true as const } : { replace: reading.replace }) });
  }
  // The one dedupe key, each key charged (ADR 2026-020).
  return meaning({ runs: withoutRepeatedRuns(ran, budget), reads: [...new Set(reads)] });
}

/** The arguments xargs reads from its input, as one word only the run can resolve. */
export const XARGS_INPUT: ShellWord = Object.freeze({ kind: "unresolved", text: "(input)", commands: Object.freeze([]) });

/** xargs's short options that take a value: the rest of their word, or the next word when they end it (GNU and BSD). */
const XARGS_VALUE_LETTERS = "IJLnPdEsaRS";
/** xargs's short options whose value, if any, is only the rest of their word: -e[eof], -l[lines], -i[replace]. */
const XARGS_ATTACHED_LETTERS = "eli";
/** GNU xargs's long options, each with how it takes a value: always (`=value` or the next word), optionally (only `=value`), or never. */
const XARGS_LONG_OPTIONS: Readonly<Record<string, "value" | "optional" | "none">> = Object.freeze({
  "--null": "none",
  "--arg-file": "value",
  "--delimiter": "value",
  "--eof": "optional",
  "--replace": "optional",
  "--max-lines": "optional",
  "--max-args": "value",
  "--max-chars": "value",
  "--interactive": "none",
  "--max-procs": "value",
  "--no-run-if-empty": "none",
  "--exit": "none",
  "--open-tty": "none",
  "--process-slot-var": "value",
  "--show-limits": "none",
  "--verbose": "none",
  "--version": "none",
  "--help": "none",
});

/** A long option as getopt_long matches it: exactly, else by a prefix of exactly one option; undefined when unknown or ambiguous. */
function xargsLongOption(name: string): string | undefined {
  if (Object.hasOwn(XARGS_LONG_OPTIONS, name)) return name;
  const matches = Object.keys(XARGS_LONG_OPTIONS).filter((option) => option.startsWith(name));
  return matches.length === 1 ? matches[0] : undefined;
}

interface XargsReading {
  readonly command: readonly ShellWord[];
  readonly replace: ShellWord | undefined;
  readonly argFiles: readonly ShellWord[];
  /** Words also read as operands, where its command starts could not be told. */
  readonly operands: readonly ShellWord[];
}

/**
 * xargs's own options, walked from `start` as getopt walks them: where its
 * command starts, its replace string (undefined when it has none; -i and a
 * bare --replace mean `{}`), and the files it reads its input from (-a).
 * Where the walk cannot tell (an unknown or ambiguous long option, or a word
 * only the shell can resolve), it goes on every plausible way: that the
 * word, or the word and the next, were options, and, for a resolvable word,
 * that the command starts there. Every reading is returned.
 */
function xargsReadings(args: readonly ShellWord[], start: number, given: { readonly replace: ShellWord | undefined; readonly argFiles: readonly ShellWord[] }, budget: WorkBudget): XargsReading[] {
  // Every reading spends from the whole command's budget; once it is spent, the command is unread, so what is returned no longer matters.
  if (!spend(budget, 1 + args.length - start)) return [];
  let replace = given.replace;
  const argFiles = [...given.argFiles];
  const reading = (command: readonly ShellWord[], operands: readonly ShellWord[] = []): XargsReading => ({ command, replace, argFiles, operands });
  /** Every way on after an option at `index` the walk cannot read: it took no value, or the next word, and the words after are also operands. */
  const uncertain = (index: number, commandHere: boolean, takesNoNextWord = false): XargsReading[] => {
    const rest = args.slice(index);
    const state = { replace, argFiles };
    return [
      ...(commandHere ? [reading(rest, rest)] : [reading([], rest)]),
      ...xargsReadings(args, index + 1, state, budget),
      ...(takesNoNextWord ? [] : xargsReadings(args, index + 2, state, budget)),
    ];
  };
  for (let index = start; index < args.length; index++) {
    const word = args[index] as ShellWord;
    const text = literal(word);
    if (text === undefined) return uncertain(index, true);
    if (text === "--") return [reading(args.slice(index + 1))];
    if (!text.startsWith("-") || text === "-") return [reading(args.slice(index))];
    if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      const option = xargsLongOption(equals === -1 ? text : text.slice(0, equals));
      const given = equals === -1 ? undefined : literalWord(text.slice(equals + 1));
      if (option === undefined) return uncertain(index, false, equals !== -1);
      const takes = XARGS_LONG_OPTIONS[option];
      if (takes === "value") {
        const value = given ?? args[++index];
        if (option === "--arg-file" && value !== undefined) argFiles.push(value);
      } else if (option === "--replace") replace = given ?? literalWord("{}");
      continue;
    }
    for (let at = 1; at < text.length; at++) {
      const letter = text.charAt(at);
      const rest = text.slice(at + 1);
      if (XARGS_VALUE_LETTERS.includes(letter)) {
        const value = rest === "" ? args[++index] : literalWord(rest);
        if ((letter === "I" || letter === "J") && value !== undefined) replace = value;
        if (letter === "a" && value !== undefined) argFiles.push(value);
        break;
      }
      if (XARGS_ATTACHED_LETTERS.includes(letter)) {
        if (letter === "i") replace = literalWord(rest === "" ? "{}" : rest);
        break;
      }
    }
  }
  return [reading([])];
}

/**
 * A program given code inline (python -c, node -e, perl -ne): what it reads
 * is taken as an unknown command's is, and the code, another language's, is
 * unresolved: only the program can say what it does. Short options cluster
 * as getopt reads them (-Bc, -lne, -pe): a letter in `codeLetters` takes the
 * rest of its word, or the next word when it ends it; a letter in
 * `valueLetters` takes the rest of its word as its value, so the cluster
 * ends there. A long option in `codeOptions` takes `=code` or the next word.
 * Without `codeAttached` (node), a code letter takes only the next word, and
 * only when it ends its cluster (-pe: -p, then -e and its code).
 */
function inlineCode(codeLetters: string, valueLetters: string, codeOptions: readonly string[] = [], codeAttached = true) {
  return (args: readonly ShellWord[]): CommandMeaning => {
    const code: ShellWord[] = [];
    for (let index = 0; index < args.length; index++) {
      const text = literal(args[index]);
      if (text === "--") break;
      if (text === undefined || !text.startsWith("-") || text === "-") continue;
      if (text.startsWith("--")) {
        const option = codeOptions.find((each) => text === each || text.startsWith(`${each}=`));
        const word = option === undefined ? undefined : text === option ? args[++index] : literalWord(text.slice(option.length + 1));
        if (word !== undefined) code.push(word);
        continue;
      }
      for (let at = 1; at < text.length; at++) {
        const letter = text.charAt(at);
        if (codeLetters.includes(letter) && (codeAttached || at === text.length - 1)) {
          const rest = text.slice(at + 1);
          const word = rest === "" ? args[++index] : literalWord(rest);
          if (word !== undefined) code.push(word);
          break;
        }
        if (valueLetters.includes(letter)) break;
      }
    }
    return meaning({ reads: readsOf(args), unresolved: code });
  };
}

/** awk and its kin: without -f, the first operand is its program, unresolved; the rest as an unknown command's. */
function awk(args: readonly ShellWord[]): CommandMeaning {
  let program: ShellWord | undefined;
  for (let index = 0; index < args.length; index++) {
    const text = literal(args[index]);
    if (text === "-f" || text === "--file" || text?.startsWith("--file=") === true || (text?.startsWith("-f") === true && !text.startsWith("--"))) return meaning({ reads: readsOf(args) });
    if (text === "-F" || text === "-v" || text === "--field-separator" || text === "--assign") index++;
    else if (text === "--") {
      program = args[index + 1];
      break;
    } else if (!isOption(args[index] as ShellWord)) {
      program = args[index];
      break;
    }
  }
  return meaning({ reads: readsOf(args), unresolved: program === undefined ? [] : [program] });
}

const TEXT = [
  "echo", "printf", "true", "false", ":", "test", "[", "[[", "export", "local", "declare", "readonly", "typeset", "unset", "alias", "unalias",
  "type", "which", "hash", "set", "shopt", "exit", "return", "wait", "jobs", "kill", "sleep", "pwd", "dirs", "history", "help", "shift", "trap",
  "umask", "break", "continue", "read",
];

const TABLE: Readonly<Record<string, (args: readonly ShellWord[], budget: WorkBudget) => CommandMeaning>> = Object.freeze({
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
  sh: (args, budget) => shell("sh", args, budget),
  bash: (args, budget) => shell("bash", args, budget),
  zsh: (args, budget) => shell("zsh", args, budget),
  dash: (args, budget) => shell("dash", args, budget),
  ksh: (args, budget) => shell("ksh", args, budget),
  tee: (args) => meaning({ writes: operands(args).map((target) => ({ word: target, change: "write" as const })) }),
  dd,
  curl,
  cd: moves,
  pushd: moves,
  popd: () => meaning({ location: { to: null } }),
  sudo: wrapper(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout"], { assignments: true, directory: ["-D", "--chdir"] }),
  doas: wrapper(["-u", "-C"]),
  env: wrapper(["-u", "--unset"], { assignments: true, directory: ["-C", "--chdir"], script: ["-S", "--split-string"], name: "env" }),
  timeout: wrapper(["-s", "--signal", "-k", "--kill-after"], { leading: 1 }),
  nice: wrapper(["-n", "--adjustment"]),
  nohup: wrapper([]),
  stdbuf: wrapper(["-i", "-o", "-e", "--input", "--output", "--error"]),
  ionice: wrapper(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]),
  builtin: (args, budget) => runs(args, budget),
  exec: (args, budget) => runs(args, budget, ["-a"]),
  command: (args, budget) => (args.some((word) => ["-v", "-V"].includes(literal(word) ?? "")) ? NONE : runs(args, budget)),
  xargs,
  eval: (args) => meaning({ unresolved: args }),
  python: inlineCode("c", "WXQm"),
  python3: inlineCode("c", "WXQm"),
  node: inlineCode("ep", "rC", ["--eval", "--print"], false),
  perl: inlineCode("eE", "MmIxCidDF0"),
  ruby: inlineCode("e", "rIECFKxTWi"),
  awk,
  gawk: awk,
  mawk: awk,
});

/**
 * The work reading one whole command may take, in steps: a step for each
 * command, each node of its syntax tree, each word a command is given or a
 * reading of xargs's options slices, each word resolved (and one more per 64
 * of its characters), and each look at what is at a path. The budget counts
 * work, not calls, so time is bounded by it. 200,000 steps run in tens of
 * milliseconds; a command built to multiply its readings (nested xargs over
 * words that cannot be told) stops there, since the reader is synchronous
 * and no timer can stop it (ADR 2026-020, which gives the measured costs).
 */
export const WORK_BUDGET_STEPS = 200_000;
/** How deep commands may nest (a wrapper's command, a nested shell's code, a substitution): far past any written by hand. */
export const MAX_NESTING = 64;

/** A fresh budget for reading one command. */
export const newWorkBudget = (outOfTime: () => boolean = () => false): WorkBudget => ({ left: WORK_BUDGET_STEPS, exhausted: false, timedOut: false, charges: 0, outOfTime });

/** How many charges pass between two looks at the time. */
const CHARGES_PER_TIME_CHECK = 64;

/** Spends `steps`; false once the budget or the time is spent, which marks it exhausted for good. */
export function spend(budget: WorkBudget, steps = 1): boolean {
  if (budget.exhausted) return false;
  // A cost that is not a count of steps (negative, not finite) spends the whole budget: it can never give steps back.
  budget.left -= Number.isFinite(steps) && steps >= 0 ? steps : budget.left + 1;
  if (budget.left < 0) budget.exhausted = true;
  else if (++budget.charges % CHARGES_PER_TIME_CHECK === 0 && budget.outOfTime()) {
    budget.exhausted = true;
    budget.timedOut = true;
  }
  return !budget.exhausted;
}

/** What the command `name` does with `args`, spending from `budget`, the whole command's: a step for the command and one per word. */
export function commandMeaning(name: string, args: readonly ShellWord[], budget: WorkBudget): CommandMeaning {
  // Each word costs a step and one per 64 characters; a short option cluster, read for every value it could carry, costs its suffixes' length.
  if (!spend(budget, 1 + args.length + textCost(args) + args.reduce((steps, word) => steps + clusterCost(word), 0))) return NONE;
  const known = Object.hasOwn(TABLE, name) ? TABLE[name] : undefined;
  return known === undefined ? meaning({ reads: readsOf(args) }) : known(args, budget);
}

