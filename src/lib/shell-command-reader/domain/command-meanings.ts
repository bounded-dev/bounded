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
  const scriptsFromNowhereKnown = withoutRepeatedWords(
    meanings.flatMap((each) => each.scriptsFromNowhereKnown ?? []),
    budget,
  );
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
    ...(scriptsFromNowhereKnown.length === 0 ? {} : { scriptsFromNowhereKnown }),
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
  /**
   * Value-taking options bounded read as flags before shell-every-reading
   * (sudo's -R, -a, -c and their long names; doas's -a): that reading is
   * kept beside the value one, added, wherever they stand (ADR 2026-020).
   */
  readonly readAsFlagsBefore?: readonly string[];
  /**
   * Options that run a shell, which reads its commands from standard input
   * when no command is given (sudo -s, -i, --shell, --login; doas -s).
   */
  readonly shellWithoutCommand?: readonly string[];
  /**
   * The long options that take no value. Given, long options are matched as
   * getopt_long matches them: exactly, else by a prefix of exactly one
   * option (sudo --us is --user); a prefix of several is read every way
   * they could take it (ADR 2026-020).
   */
  readonly longFlags?: readonly string[];
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
 * The long options `name` (a word up to its '=') may be, as getopt_long
 * matches it among `known`: itself when it is one; else every option it is
 * a prefix of (one: an abbreviation; several: ambiguous).
 */
function longCandidates(known: readonly string[], name: string): readonly string[] {
  if (known.includes(name)) return [name];
  return name.length > 2 ? known.filter((option) => option.startsWith(name)) : [];
}

/**
 * A wrapper's words, read every way they could be (ADR 2026-020). Its own
 * options are walked as getopt walks them: a short cluster letter by letter,
 * a letter that takes a value taking the rest of its word, or the next word
 * when it ends the cluster (sudo -Eu root, env -iu VAR). A word only the
 * shell can resolve where its options are is read as what today's walk takes
 * it for (the command, or timeout's duration) and also, each an added
 * reading, as a word that gives nothing, as an option that takes the next
 * word and, for a wrapper with a directory option, as that option with its
 * value attached (from nowhere known) or in the next word. A long option
 * abbreviated is read as the option it abbreviates, and also, added, as the
 * word bounded read it as before (one that takes nothing). Readings are
 * memoised by where they start, the directory, the leading operands left and
 * whether a shell was asked for, and each is charged the words left. A
 * reading that asks for a shell and gives no command reads code from
 * standard input.
 */
function wrapper(withValues: readonly string[], options: WrapperOptions = {}) {
  const valueLetters = lettersOf(withValues);
  const directoryLetters = lettersOf(options.directory ?? []);
  const scriptLetters = lettersOf(options.script ?? []);
  const shellLetters = lettersOf(options.shellWithoutCommand ?? []);
  const longs = (list: readonly string[] | undefined): string[] => (list ?? []).filter((option) => option.startsWith("--"));
  const longValues = longs(withValues);
  const longDirectories = longs(options.directory);
  const longScripts = longs(options.script);
  const knownLongs = [...longValues, ...longDirectories, ...longScripts, ...longs(options.longFlags)];
  return (args: readonly ShellWord[], budget: WorkBudget): CommandMeaning => {
    const ran: Run[] = [];
    const scripts: ShellWord[] = [];
    const unresolved: ShellWord[] = [];
    const seen = new Set<string>();
    // The memo key leaves out whether a reading is added: a state's runs are marked by the first walk to reach it. That is today's
    // reading wherever today's reading reaches it, because the walk is depth-first and takes today's reading first at every fork
    // (the command, or timeout's leading operand), and the readings a cluster keeps from before run only once today's walk is done.
    const from = (start: number, directory: ShellWord | null | undefined, leadingLeft: number, added: boolean, shellAsked = false): void => {
      const key = `${start}/${directory === undefined ? "absent" : directory === null ? "null" : wordKey(directory)}/${leadingLeft}/${shellAsked}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!spend(budget, 1 + Math.max(args.length - start, 0))) return;
      let leading = leadingLeft;
      let at = directory;
      let shell = shellAsked;
      const marks = () => ({ trailing: true as const, ...(at === undefined ? {} : { directory: at }), ...(added ? { added: true as const } : {}) });
      const run = (index: number): void => {
        const [name, ...rest] = args.slice(index);
        if (name !== undefined) ran.push({ name, args: rest, ...marks() });
        // A shell asked for and no command given reads its commands from standard input.
        else if (shell) unresolved.push(STANDARD_INPUT);
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
      /** Readings the walk kept from before a cluster was read as getopt reads it, made once this walk is done. */
      const keptReadings: (() => void)[] = [];
      /** Keeps the reading of the word at `index` as one that takes nothing, the walk going on at the next word, added. */
      const keepAsFlag = (index: number): void => {
        const [next, keptAt, keptLeading, keptShell] = [index + 1, at, leading, shell];
        keptReadings.push(() => from(next, keptAt, keptLeading, true, keptShell));
      };
      const walkWords = (): void => {
        for (let index = start; index < args.length; index++) {
          const word = args[index] as ShellWord;
          const text = literal(word);
          if (text === undefined) {
            // Only the shell can resolve it: every way it could be read, today's first.
            if (leading > 0) from(index + 1, at, leading - 1, added, shell);
            else run(index);
            // It gives nothing; or it is the directory option with its value attached, from nowhere known.
            from(index + 1, at, leading, true, shell);
            if (options.directory !== undefined) from(index + 1, null, leading, true, shell);
            // It takes the next word; or it is the directory option, the next word its value.
            from(index + 2, at, leading, true, shell);
            const value = args[index + 1];
            if (options.directory !== undefined && value !== undefined) from(index + 2, value, leading, true, shell);
            return;
          }
          if (text === "--") {
            run(index + 1);
            return;
          }
          if (text.startsWith("--")) {
            const equals = text.indexOf("=");
            const name = equals === -1 ? text : text.slice(0, equals);
            const candidates = options.longFlags === undefined ? [name] : longCandidates(knownLongs, name);
            if (candidates.length > 1 || (candidates[0] !== undefined && candidates[0] !== name)) {
              // An abbreviation, of one option or (ambiguous, which getopt_long refuses) of several: bounded read it before as a word that
              // takes nothing, and that reading goes on here; each option it may abbreviate is also read, added (fail closed).
              for (const candidate of candidates) {
                const takesDirectory = longDirectories.includes(candidate);
                if (equals === -1 && (takesDirectory || longValues.includes(candidate))) from(index + 2, takesDirectory ? (args[index + 1] ?? at) : at, leading, true, shell);
                else if (takesDirectory) from(index + 1, literalWord(text.slice(equals + 1)), leading, true, shell);
                if (options.shellWithoutCommand?.includes(candidate) === true) from(index + 1, at, leading, true, true);
              }
              continue;
            }
            if (options.shellWithoutCommand?.includes(name) === true) shell = true;
            const scriptOption = longOptionOf(options.script ?? [], text);
            if (scriptOption !== undefined) {
              if (text === scriptOption) script(args[index + 1], index + 2);
              else script(literalWord(text.slice(scriptOption.length + 1)), index + 1);
              return;
            }
            const directoryOption = longOptionOf(options.directory ?? [], text);
            if (directoryOption !== undefined) at = text === directoryOption ? args[++index] : literalWord(text.slice(directoryOption.length + 1));
            else if (withValues.includes(text)) {
              // A long option read as a flag before (sudo --chroot): that reading is kept, added.
              if (options.readAsFlagsBefore?.includes(text) === true) keepAsFlag(index);
              index++;
            }
            continue;
          }
          if (text.startsWith("-") && text !== "-") {
            // A short cluster, as getopt reads it.
            for (let letter = 1; letter < text.length; letter++) {
              const char = text.charAt(letter);
              if (shellLetters.includes(char)) shell = true;
              if (!valueLetters.includes(char) && !directoryLetters.includes(char) && !scriptLetters.includes(char)) continue;
              // Read before as a flag, the walk going on at the next word (sudo -Eu root rm: root the command; sudo -a rm: rm the
              // command): that reading is kept, added, since every reading adds. A letter first in its word that bounded took a value
              // for before (sudo -u, env -C, env -S) was read so before too, and gets no such reading.
              if (letter > 1 || options.readAsFlagsBefore?.includes(`-${char}`) === true) keepAsFlag(index);
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
        // The words ran out before a command: a shell asked for reads standard input.
        if (shell) unresolved.push(STANDARD_INPUT);
      };
      walkWords();
      for (const reading of keptReadings) reading();
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
  const ran: Run[] = [];
  for (; index < args.length; index++) {
    const action = literal(args[index]) ?? "";
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(action)) continue;
    const words: ShellWord[] = [];
    for (index++; index < args.length && ![";", "+"].includes(literal(args[index]) ?? ""); index++) words.push(args[index] as ShellWord);
    const [name, ...rest] = words;
    if (name === undefined) continue;
    // {} is a replace string whose stand-in is the path find found: listed and reported where it stands; every word is still judged as written.
    const run = { name, args: rest, replace: FOUND_PATH_REPLACE, replacedBy: FOUND_PATH };
    ran.push(run);
    // -execdir and -okdir run their command from the directory of each path found: also read from nowhere known, added (ADR 2026-020).
    if (action === "-execdir" || action === "-okdir") ran.push({ ...run, directory: null, added: true });
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
        readings.push(subcommandMeaning(args, index, budget));
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
    readings.push(subcommandMeaning(args, index, budget));
  };
  from(0, false);
  return readings.length === 1 && readings[0] !== undefined ? readings[0] : mergeMeanings(readings, budget);
}

/** What git's subcommand at `index` does with the words after it. */
function subcommandMeaning(args: readonly ShellWord[], index: number, budget: WorkBudget): CommandMeaning {
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
  const today = meaning({ reads: readsOf(rest), repositoryReads });
  const writing = subcommand === undefined || !Object.hasOwn(GIT_WRITES, subcommand) ? undefined : GIT_WRITES[subcommand];
  return writing === undefined ? today : mergeMeanings([today, writing(rest, budget)], budget);
}

/** What git writes in the working tree beyond the paths it names, as one word only git can resolve. */
export const WORKING_TREE: ShellWord = Object.freeze({ kind: "unresolved", text: "(the working tree)", commands: Object.freeze([]) });
const workingTree = { word: WORKING_TREE, change: "write" as const };

/** A git subcommand's options, as `git <subcommand> -h` lists them (git 2.54.0): those that take a value, and those that take none. */
interface GitOptions {
  readonly values: readonly string[];
  readonly flags: readonly string[];
}

/** One reading of a git subcommand's words: its operands, how many came before '--' (when given), and its options, each by its long name where it has one. */
interface GitReading {
  readonly operands: readonly ShellWord[];
  readonly beforeDashDash: number | undefined;
  readonly given: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, readonly ShellWord[]>;
}

/** A list of words kept as its last word and the list before it, so a reading adds an operand in a step, never copying the list. */
interface WordList {
  readonly word: ShellWord;
  readonly before: WordList | undefined;
  readonly length: number;
}
const wordsIn = (list: WordList | undefined): ShellWord[] => {
  const out: ShellWord[] = [];
  for (let at = list; at !== undefined; at = at.before) out.push(at.word);
  return out.reverse();
};

/** Where a reading of a git subcommand's words stands as it walks them. */
interface GitWalk {
  readonly operands: WordList | undefined;
  readonly beforeDashDash: number | undefined;
  readonly given: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, readonly ShellWord[]>;
}

/**
 * Every reading of a git subcommand's words, as git's parse-options reads
 * them: short options cluster, a value option taking the rest of its word or
 * the next; long options by their name or a prefix of exactly one, `=value`
 * or the next word, `--no-` before a flag; options anywhere before '--'.
 * Where it cannot tell (an unknown or ambiguous option, a word only the shell
 * can resolve) it goes on every way: the word an operand, an option that
 * takes nothing, or one that takes the next word (ADR 2026-020). A word read
 * one way costs a step; where the walk forks, the readings are memoised by
 * where they stand and what they have read, each charged that state's size
 * and the words left.
 */
function gitReadings(args: readonly ShellWord[], options: GitOptions, aliases: Readonly<Record<string, string>>, budget: WorkBudget): GitReading[] {
  const readings: GitReading[] = [];
  const seen = new Set<string>();
  const longs = [...options.values, ...options.flags].filter((option) => option.startsWith("--"));
  const canonical = (option: string): string => aliases[option] ?? option;
  /** `state` with `option` given, and `value` when it takes one. */
  const givenIn = (state: GitWalk, option: string, value?: ShellWord): GitWalk => {
    const name = canonical(option);
    if (value === undefined && !options.values.includes(option)) return { ...state, given: new Set([...state.given, name]) };
    const values = new Map(state.values);
    values.set(name, [...(values.get(name) ?? []), ...(value === undefined ? [] : [value])]);
    return { ...state, values, given: new Set([...state.given, name]) };
  };
  /** Where the walk goes on from word `index` in `state`: one place, or several where it cannot tell. */
  const onwards = (index: number, state: GitWalk, word: ShellWord): [number, GitWalk][] => {
    const operand: GitWalk = { ...state, operands: { word, before: state.operands, length: (state.operands?.length ?? 0) + 1 } };
    const text = literal(word);
    if (state.beforeDashDash !== undefined) return [[index + 1, operand]];
    // Only the shell can resolve it: an operand, an option that takes nothing, or one that takes the next word.
    if (text === undefined) return [[index + 1, operand], [index + 1, state], [index + 2, state]];
    if (text === "--") return [[index + 1, { ...state, beforeDashDash: state.operands?.length ?? 0 }]];
    if (!text.startsWith("-") || text === "-") return [[index + 1, operand]];
    if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      const name = equals === -1 ? text : text.slice(0, equals);
      const attached = equals === -1 ? undefined : literalWord(text.slice(equals + 1));
      if (name.startsWith("--no-") && longs.includes(`--${name.slice(5)}`)) return [[index + 1, { ...state, given: new Set([...state.given, name]) }]];
      const candidates = longCandidates(longs, name);
      const [option] = candidates;
      // Unknown or ambiguous: it takes nothing, or it takes the next word.
      if (candidates.length !== 1 || option === undefined) return attached === undefined ? [[index + 1, state], [index + 2, state]] : [[index + 1, state]];
      if (!options.values.includes(option)) return [[index + 1, givenIn(state, option)]];
      return attached === undefined ? [[index + 2, givenIn(state, option, args[index + 1])]] : [[index + 1, givenIn(state, option, attached)]];
    }
    let next = state;
    for (let at = 1; at < text.length; at++) {
      const option = `-${text.charAt(at)}`;
      if (options.values.includes(option)) {
        const rest = text.slice(at + 1);
        return rest === "" ? [[index + 2, givenIn(next, option, args[index + 1])]] : [[index + 1, givenIn(next, option, literalWord(rest))]];
      }
      // A letter git does not list: the word takes nothing, or the next word.
      if (!options.flags.includes(option)) return [[index + 1, next], [index + 2, next]];
      next = givenIn(next, option);
    }
    return [[index + 1, next]];
  };
  const waiting: [number, GitWalk][] = [[0, { operands: undefined, beforeDashDash: undefined, given: new Set(), values: new Map() }]];
  for (let place = waiting.pop(); place !== undefined; place = waiting.pop()) {
    let [index, state] = place;
    // One way on: a step a word. Where the walk forks, each way is memoised by its whole state, charged its size and the words left.
    for (let word = args[index]; word !== undefined; word = args[index]) {
      if (!spend(budget)) return readings;
      const ways = onwards(index, state, word);
      const [only] = ways;
      if (ways.length === 1 && only !== undefined) {
        [index, state] = only;
        continue;
      }
      for (const [at, way] of ways.reverse()) {
        const operandWords = wordsIn(way.operands);
        if (!spend(budget, 1 + operandWords.length + Math.max(args.length - at, 0))) return readings;
        const key = JSON.stringify([at, operandWords.map(wordKey), way.beforeDashDash ?? null, [...way.given].sort(), [...way.values].map(([option, words]) => [option, words.map(wordKey)])]);
        if (seen.has(key)) continue;
        seen.add(key);
        waiting.push([at, way]);
      }
      break;
    }
    if (args[index] === undefined) readings.push({ operands: wordsIn(state.operands), beforeDashDash: state.beforeDashDash, given: state.given, values: state.values });
  }
  return readings;
}

/** Whether a pathspec may reach more than the path it spells: '.', a glob, or magic (':'). One naming a directory is told where the command runs. */
const widePathspec = (word: ShellWord): boolean => word.kind === "unresolved" || word.text === "." || /[*?[]/.test(word.text) || word.text.startsWith(":");
/** The writes of `pathspecs`: each written as the path it spells, and the working tree too where one may reach more. */
const pathspecWrites = (pathspecs: readonly ShellWord[]): CommandMeaning["writes"] => [
  ...pathspecs.map((word) => ({ word, change: "write" as const, pathspec: true as const })),
  ...(pathspecs.some(widePathspec) ? [workingTree] : []),
];

/** The meaning of each reading of a git subcommand's words, merged; today's reading of them is the caller's. */
function gitWriting(options: GitOptions, aliases: Readonly<Record<string, string>>, writes: (reading: GitReading) => CommandMeaning["writes"]) {
  return (args: readonly ShellWord[], budget: WorkBudget): CommandMeaning => mergeMeanings(
    gitReadings(args, options, aliases, budget).map((reading) => meaning({ writes: writes(reading) })),
    budget,
  );
}

const CHECKOUT_FLAGS = ["-q", "--quiet", "-f", "--force", "-m", "--merge", "-d", "--detach", "-p", "--patch", "--ours", "--theirs", "-2", "-3", "-t", "--track", "--guess", "-l", "--overlay", "--ignore-skip-worktree-bits", "--ignore-other-worktrees", "--recurse-submodules", "--progress", "--overwrite-ignore", "--auto-advance", "--pathspec-file-nul"];
const CHECKOUT_ALIASES: Readonly<Record<string, string>> = Object.freeze({ "-q": "--quiet", "-f": "--force", "-m": "--merge", "-d": "--detach", "-p": "--patch", "-2": "--ours", "-3": "--theirs", "-t": "--track", "-U": "--unified", "-c": "--create", "-C": "--force-create", "-s": "--source", "-S": "--staged", "-W": "--worktree", "-k": "--keep-index", "-u": "--include-untracked", "-a": "--all", "-N": "--intent-to-add", "-R": "--reverse", "-v": "--verbose", "-n": "--no-checkout", "-o": "--origin", "-b": "--branch", "-j": "--jobs" });
/** Options after which git checks out more than the paths named: the working tree is written. */
const OVERWRITES = ["--force", "--merge", "--discard-changes"];
const anyGiven = (reading: GitReading, ...options: string[]): boolean => options.some((option) => reading.given.has(option));
/** The operands after '--', or every operand when there is none. */
const pathspecsOf = (reading: GitReading): readonly ShellWord[] => (reading.beforeDashDash === undefined ? reading.operands : reading.operands.slice(reading.beforeDashDash));

/**
 * git's subcommands that write the working tree (checkout, switch, restore,
 * apply, stash, reset, clone): each written path every plausible way, and
 * `(the working tree)` where git writes more than the paths named. Options
 * listed from `git <subcommand> -h` of git 2.54.0.
 */
const GIT_WRITES: Readonly<Record<string, (args: readonly ShellWord[], budget: WorkBudget) => CommandMeaning>> = Object.freeze({
  checkout: gitWriting(
    { values: ["-b", "-B", "--orphan", "--conflict", "-U", "--unified", "--inter-hunk-context", "--pathspec-from-file"], flags: CHECKOUT_FLAGS },
    { ...CHECKOUT_ALIASES, "-b": "-b" },
    (reading) => {
      const overwrites = anyGiven(reading, ...OVERWRITES, "--pathspec-from-file") ? [workingTree] : [];
      if (reading.beforeDashDash !== undefined) {
        const pathspecs = pathspecsOf(reading);
        // A tree-ish (or a new branch) and no pathspec switches branches.
        const switches = pathspecs.length === 0 && (reading.beforeDashDash > 0 || anyGiven(reading, "-b", "-B", "--orphan")) ? [workingTree] : [];
        return [...pathspecWrites(pathspecs), ...switches, ...overwrites];
      }
      // A new branch: written only from a start point.
      if (anyGiven(reading, "-b", "-B", "--orphan")) return [...(reading.operands.length > 0 ? [workingTree] : []), ...overwrites];
      // A branch or a path, git decides: each operand written, and the working tree.
      return reading.operands.length === 0 ? overwrites : [...pathspecWrites(reading.operands), workingTree, ...overwrites];
    },
  ),
  switch: gitWriting(
    {
      values: ["-c", "--create", "-C", "--force-create", "--orphan", "--conflict"],
      flags: ["--guess", "--discard-changes", "-q", "--quiet", "--recurse-submodules", "--progress", "-m", "--merge", "-d", "--detach", "-t", "--track", "-f", "--force", "--overwrite-ignore", "--ignore-other-worktrees"],
    },
    CHECKOUT_ALIASES,
    (reading) => {
      const overwrites = anyGiven(reading, ...OVERWRITES) ? [workingTree] : [];
      if (anyGiven(reading, "--create", "--force-create")) return [...(reading.operands.length > 0 ? [workingTree] : []), ...overwrites];
      // --orphan empties the working tree of tracked files.
      return reading.operands.length > 0 || anyGiven(reading, "--orphan") ? [workingTree] : overwrites;
    },
  ),
  restore: gitWriting(
    {
      values: ["-s", "--source", "--conflict", "-U", "--unified", "--inter-hunk-context", "--pathspec-from-file"],
      flags: ["-S", "--staged", "-W", "--worktree", "--ignore-unmerged", "--overlay", "-q", "--quiet", "--recurse-submodules", "--progress", "-m", "--merge", "-2", "--ours", "-3", "--theirs", "-p", "--patch", "--auto-advance", "--ignore-skip-worktree-bits", "--pathspec-file-nul"],
    },
    CHECKOUT_ALIASES,
    (reading) => {
      // --staged alone restores the index only.
      if (anyGiven(reading, "--staged") && !anyGiven(reading, "--worktree")) return [];
      return [...pathspecWrites(reading.operands), ...(anyGiven(reading, "--merge", "--pathspec-from-file") ? [workingTree] : [])];
    },
  ),
  apply: gitWriting(
    {
      values: ["--exclude", "--include", "-p", "-C", "--whitespace", "--build-fake-ancestor", "--directory"],
      flags: ["--no-add", "--add", "--stat", "--numstat", "--summary", "--check", "--index", "-N", "--intent-to-add", "--cached", "--unsafe-paths", "--apply", "-3", "--3way", "--ours", "--theirs", "--union", "-z", "--ignore-space-change", "--ignore-whitespace", "-R", "--reverse", "--unidiff-zero", "--reject", "--allow-overlap", "-v", "--verbose", "-q", "--quiet", "--inaccurate-eof", "--recount", "--allow-empty"],
    },
    { ...CHECKOUT_ALIASES, "-3": "--3way" },
    (reading) => {
      const ancestor = (reading.values.get("--build-fake-ancestor") ?? []).map((word) => ({ word, change: "write" as const }));
      // Only reports, or the index only, unless --apply is also given.
      if (anyGiven(reading, "--check", "--stat", "--numstat", "--summary", "--cached") && !anyGiven(reading, "--apply")) return ancestor;
      return [workingTree, ...ancestor];
    },
  ),
  stash: (args: readonly ShellWord[]): CommandMeaning => {
    const [first] = args;
    const subcommand = literal(first);
    // list, show, drop, clear, create, store, export and import leave the working tree; push (also with options alone), save, pop,
    // apply and branch write it; a word only the shell can resolve may be any of them.
    const leaves = subcommand !== undefined && ["list", "show", "drop", "clear", "create", "store", "export", "import"].includes(subcommand);
    return leaves ? NONE : meaning({ writes: [workingTree] });
  },
  reset: gitWriting(
    {
      values: ["-U", "--unified", "--inter-hunk-context", "--pathspec-from-file"],
      flags: ["-q", "--quiet", "--no-refresh", "--refresh", "--mixed", "--soft", "--hard", "--merge", "--keep", "--recurse-submodules", "-p", "--patch", "--auto-advance", "-N", "--intent-to-add", "--pathspec-file-nul"],
    },
    CHECKOUT_ALIASES,
    (reading) => (anyGiven(reading, "--hard", "--merge", "--keep") ? [workingTree] : []),
  ),
  clone: gitWriting(
    {
      values: ["-j", "--jobs", "--template", "--reference", "--reference-if-able", "-o", "--origin", "-b", "--branch", "--revision", "-u", "--upload-pack", "--depth", "--shallow-since", "--shallow-exclude", "--separate-git-dir", "--ref-format", "-c", "--config", "--server-option", "--filter", "--bundle-uri"],
      flags: ["-v", "--verbose", "-q", "--quiet", "--progress", "--reject-shallow", "-n", "--no-checkout", "--checkout", "--bare", "--mirror", "-l", "--local", "--no-hardlinks", "--hardlinks", "-s", "--shared", "--recurse-submodules", "--recursive", "--dissociate", "--single-branch", "--tags", "--shallow-submodules", "-4", "--ipv4", "-6", "--ipv6", "--also-filter-submodules", "--remote-submodules", "--sparse"],
    },
    CHECKOUT_ALIASES,
    (reading) => {
      const [source, destination] = reading.operands;
      const separate = (reading.values.get("--separate-git-dir") ?? []).map((word) => ({ word, change: "create" as const }));
      if (destination !== undefined) return [{ word: destination, change: "create" as const }, ...separate];
      if (source === undefined) return separate;
      const named = source.kind === "literal" ? cloneDirectoryOf(source.text, anyGiven(reading, "--bare", "--mirror")) : undefined;
      // A source only the shell can name creates a directory only the shell can name.
      return [{ word: named === undefined ? source : literalWord(named), change: "create" as const }, ...separate];
    },
  ),
});

/**
 * The directory git clone creates for `source` when none is given, as git's
 * git_url_basename names it: its last path segment (after the last '/' or
 * ':'), trailing slashes and a '.git' (or '.bundle') ending dropped, '.git'
 * added for a bare clone; undefined when nothing is left.
 */
function cloneDirectoryOf(source: string, bare: boolean): string | undefined {
  let text = source.replace(/\/+$/, "");
  if (text.endsWith("/.git")) text = text.slice(0, -5).replace(/\/+$/, "");
  text = text.replace(/\.(git|bundle)$/, "");
  const name = text.slice(Math.max(text.lastIndexOf("/"), text.lastIndexOf(":")) + 1);
  if (name === "" || name === "." || name === "..") return undefined;
  return bare ? `${name}.git` : name;
}

/** The code a shell reads from its standard input, as one word only the run can resolve. */
export const STANDARD_INPUT: ShellWord = Object.freeze({ kind: "unresolved", text: "(standard input)", commands: Object.freeze([]) });
/** What a pipe gives a command after the first of a pipeline, as one word only the run can resolve. */
export const PIPED_INPUT: ShellWord = Object.freeze({ kind: "unresolved", text: "(piped input)", commands: Object.freeze([]) });

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

/**
 * What a package runner's option does: takes a value (`value`), names the
 * directory its command runs from (`directory`), runs it from a directory
 * that cannot be told (`nowhere`: a workspace, each package's), or is code
 * (`code`: npx -c); or takes none (`flag`, `nowhere`, or `shell`: the
 * command is a shell command line, pnpm exec -c).
 */
interface RunnerOptions {
  readonly values: Readonly<Record<string, "value" | "directory" | "nowhere" | "code">>;
  readonly flags: Readonly<Record<string, "flag" | "nowhere" | "shell">>;
}

/** A package runner's grammar: its options, and, when its command follows a subcommand (pnpm exec, yarn dlx), that word and the options after it. */
interface RunnerGrammar extends RunnerOptions {
  readonly subcommand?: { readonly word: string; readonly options: RunnerOptions };
}

/** The program a package word runs: its name without a trailing @<version>, by its last '/' segment (cdktf@0.20 runs cdktf, @scope/tool@1 runs tool). */
function packageProgram(word: ShellWord): ShellWord {
  if (word.kind !== "literal") return word;
  const versionAt = word.text.indexOf("@", word.text.startsWith("@") ? 1 : 0);
  const name = (versionAt > 0 ? word.text.slice(0, versionAt) : word.text).split("/").at(-1) ?? "";
  return name === "" || name === word.text ? word : literalWord(name);
}

/**
 * A package runner (npx, pnpx, bunx, bun x, pnpm exec, yarn dlx, uvx, uv
 * tool run): today's reading of it, a program bounded does not know reading
 * its operands, is kept; after its own options its words run as a command,
 * the package word naming the program, an added run (ADR 2026-020). An
 * option it does not know may take nothing or the next word, and a word only
 * the shell can resolve may be either or the package: every reading is
 * made, memoised by where it starts and what it has set, each charged the
 * words left. A runner whose subcommand is not its runner's (pnpm install)
 * runs nothing bounded can name: uninterpreted, as before.
 */
function runner(grammar: RunnerGrammar, skip = 0) {
  return (args: readonly ShellWord[], budget: WorkBudget): CommandMeaning => {
    const ran: Run[] = [];
    const scripts: ShellWord[] = [];
    const unresolved: ShellWord[] = [];
    const seen = new Set<string>();
    let reached = grammar.subcommand === undefined;
    const from = (index: number, inSubcommand: boolean, directory: ShellWord | null | undefined, shellMode: boolean): void => {
      const key = `${index}/${inSubcommand}/${directory === undefined ? "absent" : directory === null ? "null" : wordKey(directory)}/${shellMode}`;
      if (seen.has(key) || !spend(budget, 1 + Math.max(args.length - index, 0))) return;
      seen.add(key);
      const options = inSubcommand && grammar.subcommand !== undefined ? grammar.subcommand.options : grammar;
      const commandHere = grammar.subcommand === undefined || inSubcommand;
      const command = (at: number): void => {
        const [word, ...rest] = args.slice(at);
        if (word === undefined) return;
        if (shellMode) {
          // The command line is a shell's: its first word is code, the words after it handed to it.
          scripts.push(word);
          unresolved.push(...rest);
          return;
        }
        ran.push({ name: packageProgram(word), args: rest, trailing: true, added: true, ...(directory === undefined ? {} : { directory }) });
      };
      const word = args[index];
      if (word === undefined) return;
      const text = literal(word);
      if (text === undefined) {
        // Only the shell can resolve it: the command (or the subcommand), an option that takes nothing, or one that takes the next word.
        if (commandHere) command(index);
        else {
          reached = true;
          from(index + 1, true, directory, shellMode);
        }
        from(index + 1, inSubcommand, directory, shellMode);
        from(index + 2, inSubcommand, directory, shellMode);
        return;
      }
      if (text === "--") {
        if (commandHere) command(index + 1);
        else from(index + 1, inSubcommand, directory, shellMode);
        return;
      }
      if (!text.startsWith("-") || text === "-") {
        if (commandHere) command(index);
        else if (text === grammar.subcommand?.word) {
          reached = true;
          from(index + 1, true, directory, shellMode);
        }
        return;
      }
      const equals = text.startsWith("--") ? text.indexOf("=") : -1;
      const name = equals === -1 ? text : text.slice(0, equals);
      const shortAttached = !text.startsWith("--") && text.length > 2 && Object.hasOwn(options.values, text.slice(0, 2)) ? text.slice(0, 2) : undefined;
      const valueOption = Object.hasOwn(options.values, name) ? name : shortAttached;
      if (valueOption !== undefined) {
        const kind = options.values[valueOption];
        const value = valueOption === shortAttached ? literalWord(text.slice(2)) : equals === -1 ? args[index + 1] : literalWord(text.slice(equals + 1));
        const next = valueOption === shortAttached || equals !== -1 ? index + 1 : index + 2;
        if (kind === "code") {
          if (value !== undefined) scripts.push(value);
          return;
        }
        const at = kind === "directory" ? (value?.kind === "literal" ? value : null) : kind === "nowhere" ? null : directory;
        from(next, inSubcommand, at, shellMode);
        return;
      }
      if (Object.hasOwn(options.flags, name) && equals === -1) {
        const kind = options.flags[name];
        from(index + 1, inSubcommand, kind === "nowhere" ? null : directory, shellMode || kind === "shell");
        return;
      }
      // An option it does not know: it takes nothing, or it takes the next word.
      from(index + 1, inSubcommand, directory, shellMode);
      if (equals === -1) from(index + 2, inSubcommand, directory, shellMode);
    };
    from(skip, false, undefined, false);
    const today = { reads: readsOf(args) };
    if (!reached) return meaning({ ...today, uninterpreted: true });
    return meaning({ ...today, runs: withoutRepeatedRuns(ran, budget), scripts: withoutRepeatedWords(scripts, budget), unresolved: withoutRepeatedWords(unresolved, budget) });
  };
}

const NPX: RunnerGrammar = Object.freeze<RunnerGrammar>({
  values: { "-p": "value", "--package": "value", "-w": "nowhere", "--workspace": "nowhere", "-c": "code", "--call": "code" },
  flags: { "-y": "flag", "--yes": "flag", "--no": "flag", "--no-install": "flag", "-q": "flag", "--quiet": "flag", "-s": "flag", "--silent": "flag", "--ws": "nowhere", "--workspaces": "nowhere", "--include-workspace-root": "flag", "--prefer-online": "flag", "--prefer-offline": "flag", "--offline": "flag" },
});
const BUNX: RunnerGrammar = Object.freeze<RunnerGrammar>({
  values: { "-p": "value", "--package": "value", "--cwd": "directory" },
  flags: { "--bun": "flag", "--silent": "flag", "--verbose": "flag", "--no-install": "flag" },
});
const PNPM: RunnerGrammar = Object.freeze<RunnerGrammar>({
  values: { "--filter": "nowhere", "-F": "nowhere", "-C": "directory", "--dir": "directory" },
  flags: { "-r": "nowhere", "--recursive": "nowhere", "-w": "nowhere", "--workspace-root": "nowhere", "-s": "flag", "--silent": "flag" },
  subcommand: {
    word: "exec",
    options: {
      values: { "--filter": "nowhere", "-F": "nowhere", "--resume-from": "value" },
      flags: { "-c": "shell", "--shell-mode": "shell", "--parallel": "flag", "--no-bail": "flag", "--report-summary": "flag", "-r": "nowhere", "--recursive": "nowhere" },
    },
  },
});
const YARN: RunnerGrammar = Object.freeze<RunnerGrammar>({
  values: { "--cwd": "directory" },
  flags: {},
  subcommand: { word: "dlx", options: { values: { "-p": "value", "--package": "value" }, flags: { "-q": "flag", "--quiet": "flag" } } },
});
const UVX: RunnerGrammar = Object.freeze<RunnerGrammar>({
  values: { "--from": "value", "--with": "value", "--with-editable": "value", "--with-requirements": "value", "--python": "value", "-p": "value", "--directory": "directory", "--index": "value", "--index-url": "value", "--extra-index-url": "value", "--default-index": "value" },
  flags: { "-q": "flag", "--quiet": "flag", "-v": "flag", "--verbose": "flag", "--isolated": "flag", "--offline": "flag", "--no-cache": "flag", "-n": "flag" },
});

/** bun and uv run a package only through bun x and uv tool run: any other subcommand is uninterpreted, as before. */
const bun = (args: readonly ShellWord[], budget: WorkBudget): CommandMeaning => (literal(args[0]) === "x" ? runner(BUNX, 1)(args, budget) : meaning({ reads: readsOf(args), uninterpreted: true }));
const uv = (args: readonly ShellWord[], budget: WorkBudget): CommandMeaning =>
  literal(args[0]) === "tool" && literal(args[1]) === "run" ? runner(UVX, 2)(args, budget) : meaning({ reads: readsOf(args), uninterpreted: true });

/**
 * A text program that never runs its input or arguments as code (grep, sort,
 * jq …): today's reading (every operand, every long option's =value and
 * every short option's attached value, read), and the values of its
 * file-valued options read, of its writing options written, of its
 * command-valued options run. Options are read anywhere before '--', as GNU
 * getopt permutes them, each value-taking one taking the rest of its word,
 * `=value`, or the next word.
 */
interface TextProgram {
  readonly values?: readonly string[];
  readonly fileValues?: readonly string[];
  readonly writeValues?: readonly string[];
  readonly runValues?: readonly string[];
  /** Options that take two words, a name then a value (jq's --arg), and whether the value is a file read. */
  readonly pairs?: Readonly<Record<string, "file" | "text">>;
  /** Options after which its operands, past the first (yq's expression), are written in place. */
  readonly inPlace?: readonly string[];
  /** Its second operand is its output (uniq in out). */
  readonly writesSecondOperand?: true;
}

function textProgram(program: TextProgram) {
  const values = [...(program.values ?? []), ...(program.fileValues ?? []), ...(program.writeValues ?? []), ...(program.runValues ?? [])];
  return (args: readonly ShellWord[], budget: WorkBudget): CommandMeaning => {
    const reads: ShellWord[] = [];
    const writes: { word: ShellWord; change: "write" }[] = [];
    const ran: Run[] = [];
    const named: ShellWord[] = [];
    let inPlace = false;
    const given = (option: string, value: ShellWord | undefined): void => {
      if (value === undefined) return;
      if (program.fileValues?.includes(option) === true) reads.push(value);
      if (program.writeValues?.includes(option) === true) writes.push({ word: value, change: "write" });
      if (program.runValues?.includes(option) === true) {
        // The command it runs on each file (rg --pre): its value names the program, and, split on spaces, is read as a command line too.
        ran.push({ name: value, args: [], added: true });
        const split = value.kind === "literal" && !NOT_SPLIT.test(value.text) ? value.text.split(/[ \t\n]+/).filter((each) => each !== "") : [];
        const [name, ...rest] = split;
        if (name !== undefined && split.length > 1) ran.push({ name: literalWord(name), args: rest.map(literalWord), added: true });
      }
    };
    let options = true;
    for (let index = 0; index < args.length; index++) {
      const word = args[index] as ShellWord;
      const text = literal(word);
      if (!options || text === undefined || !text.startsWith("-") || text === "-") {
        named.push(word);
        continue;
      }
      if (text === "--") {
        options = false;
        continue;
      }
      if (program.inPlace?.includes(text) === true) inPlace = true;
      const pair = program.pairs !== undefined && Object.hasOwn(program.pairs, text) ? program.pairs[text] : undefined;
      if (pair !== undefined) {
        const value = args[index + 2];
        if (pair === "file" && value !== undefined) reads.push(value);
        index += 2;
        continue;
      }
      if (text.startsWith("--")) {
        const equals = text.indexOf("=");
        const option = equals === -1 ? text : text.slice(0, equals);
        if (!values.includes(option)) continue;
        given(option, equals === -1 ? args[++index] : literalWord(text.slice(equals + 1)));
        continue;
      }
      for (let at = 1; at < text.length; at++) {
        const option = `-${text.charAt(at)}`;
        if (program.inPlace?.includes(option) === true) inPlace = true;
        if (!values.includes(option)) continue;
        const rest = text.slice(at + 1);
        given(option, rest === "" ? args[++index] : literalWord(rest));
        break;
      }
    }
    if (program.writesSecondOperand === true && named[1] !== undefined) writes.push({ word: named[1], change: "write" });
    if (inPlace) for (const word of named.length > 1 ? named.slice(1) : named) writes.push({ word, change: "write" });
    // Today's reads, and each file-valued option's value they do not hold already (one starting with '-').
    const today = readsOf(args);
    const readToday = new Set(today.map(wordKey));
    return meaning({ reads: [...today, ...reads.filter((word) => !readToday.has(wordKey(word)))], writes, runs: withoutRepeatedRuns(ran, budget) });
  };
}

const GREP: TextProgram = {
  values: ["-e", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--max-count", "--after-context", "--before-context", "--directories", "--devices", "--label", "--include", "--exclude", "--exclude-dir", "--binary-files", "--group-separator"],
  fileValues: ["-f", "--file", "--exclude-from"],
};
const LESS: TextProgram = {
  values: ["-b", "-h", "-j", "-p", "-P", "-t", "-x", "-y", "-z", "-#", "--tag", "--pattern", "--prompt", "--shift", "--tabs", "--window", "--buffers", "--max-back-scroll", "--max-forw-scroll", "--jump-target"],
  fileValues: ["-k", "--lesskey-file", "-T", "--tag-file"],
  writeValues: ["-o", "-O", "--log-file", "--LOG-FILE"],
};
const CHECKSUM: TextProgram = { values: ["-a", "--algorithm"] };

/**
 * The common text programs that never run their input or arguments as code,
 * each checked against its --help or usage where the machine the item was
 * built on had it (grep 2.6.0-FreeBSD, ripgrep 14.1.1, jq 1.7.1, Apple
 * diff, less 668, sort 2.3-Apple, file 5.41, macOS's stat, date, uniq, wc,
 * column and base64), else against GNU coreutils' and yq's (v4)
 * documentation (ADR 2026-020).
 */
const TEXT_PROGRAMS: Readonly<Record<string, TextProgram>> = Object.freeze({
  // cat was read by the default before; an entry now, so what reaches it stays a read (cat "$F", cat a | cat).
  cat: {},
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: {
    values: ["-e", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-j", "-M", "-E", "-r", "--regexp", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--type-clear", "--max-count", "--after-context", "--before-context", "--context", "--threads", "--max-columns", "--encoding", "--replace", "--sort", "--sortr", "--pre-glob", "--max-depth", "--max-filesize", "--colors", "--context-separator", "--field-context-separator", "--field-match-separator", "--path-separator", "--dfa-size-limit", "--regex-size-limit", "--engine", "--hyperlink-format"],
    fileValues: ["-f", "--file", "--ignore-file"],
    runValues: ["--pre", "--hostname-bin"],
  },
  head: { values: ["-n", "-c", "--lines", "--bytes"] },
  tail: { values: ["-n", "-c", "-b", "-s", "--lines", "--bytes", "--sleep-interval", "--pid", "--max-unchanged-stats"] },
  sort: {
    values: ["-k", "-t", "-T", "-S", "--key", "--field-separator", "--temporary-directory", "--buffer-size", "--parallel", "--batch-size", "--sort"],
    fileValues: ["--files0-from", "--random-source"],
    writeValues: ["-o", "--output"],
    runValues: ["--compress-program"],
  },
  uniq: { values: ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"], writesSecondOperand: true },
  wc: { fileValues: ["--files0-from"] },
  cut: { values: ["-b", "-c", "-d", "-f", "--bytes", "--characters", "--delimiter", "--fields", "--output-delimiter"] },
  tr: {},
  jq: { values: ["--indent"], fileValues: ["-f", "--from-file", "-L"], pairs: { "--arg": "text", "--argjson": "text", "--slurpfile": "file", "--rawfile": "file" } },
  yq: { values: ["-o", "--output-format", "-p", "--input-format", "-I", "--indent", "--expression"], fileValues: ["--from-file"], inPlace: ["-i", "--inplace"] },
  column: { values: ["-c", "-s", "-o", "-N", "-R", "-T", "-E", "-H", "-W", "-l", "-r", "--output-width", "--separator", "--output-separator", "--table-columns", "--table-right", "--table-truncate", "--table-noextreme", "--table-hide", "--table-wrap", "--table-name", "--tree", "--tree-id", "--tree-parent", "--table-order"] },
  nl: { values: ["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w", "--body-numbering", "--section-delimiter", "--footer-numbering", "--header-numbering", "--line-increment", "--join-blank-lines", "--number-format", "--number-separator", "--starting-line-number", "--number-width"] },
  less: LESS,
  more: LESS,
  diff: {
    values: ["-C", "-U", "-I", "-x", "-S", "-L", "-F", "-D", "-W", "--label", "--exclude", "--ignore-matching-lines", "--starting-file", "--ifdef", "--show-function-line", "--line-format", "--old-line-format", "--new-line-format", "--unchanged-line-format", "--old-group-format", "--new-group-format", "--changed-group-format", "--unchanged-group-format", "--horizon-lines", "--tabsize", "--width"],
    fileValues: ["--from-file", "--to-file", "-X", "--exclude-from"],
  },
  cmp: { values: ["-i", "-n", "--ignore-initial", "--bytes"] },
  comm: { values: ["--output-delimiter"] },
  paste: { values: ["-d", "--delimiters"] },
  fold: { values: ["-w", "--width"] },
  fmt: { values: ["-w", "-g", "-p", "--width", "--goal", "--prefix"] },
  rev: {},
  tac: { values: ["-s", "--separator"] },
  base64: { values: ["-b", "-w", "--wrap", "--break"], fileValues: ["-i", "--input"], writeValues: ["-o", "--output"] },
  md5sum: CHECKSUM,
  sha1sum: CHECKSUM,
  sha224sum: CHECKSUM,
  sha256sum: CHECKSUM,
  sha384sum: CHECKSUM,
  sha512sum: CHECKSUM,
  shasum: CHECKSUM,
  file: { values: ["-F", "--separator", "-e", "--exclude", "--exclude-quiet", "-P", "--parameter"], fileValues: ["-f", "--files-from", "-m", "--magic-file", "-M"] },
  stat: { values: ["-c", "--format", "--printf", "-t"] },
  basename: { values: ["-s", "--suffix"] },
  dirname: {},
  realpath: { fileValues: ["--relative-to", "--relative-base"] },
  date: { values: ["-d", "--date", "-s", "--set", "-v"], fileValues: ["-f", "--file", "-r", "--reference"] },
  seq: { values: ["-f", "-s", "--format", "--separator"] },
});

/** What reaches a program that times a command which moves the shell (time cd sub): bash runs it in this shell, which the reading cannot place. */
export const TIME_MOVES: ShellWord = Object.freeze({ kind: "unresolved", text: "(where time's command moves the shell)", commands: Object.freeze([]) });
/** A coproc's { … } body, which the grammar cuts at its first ';': its later statements are read as commands of their own. */
export const COPROC_BODY: ShellWord = Object.freeze({ kind: "unresolved", text: "(coproc's { … } body)", commands: Object.freeze([]) });

const TIME_WRAPPER = wrapper(["-o", "--output", "-f", "--format"]);

/**
 * time (bash's keyword, or /usr/bin/time): its command runs, an added run,
 * after its options (-p; /usr/bin/time's -o <file>, written, and -f <format>)
 * and a lone '{' the grammar leaves of `time { …; }` (recorded); today's
 * reading, its words read, is kept. Where the command would move where later
 * commands run (time cd sub), bash runs it in this shell, which the reading
 * cannot place: that is reported, unresolved code (ADR 2026-020).
 */
function time(args: readonly ShellWord[], budget: WorkBudget): CommandMeaning {
  const writes: { word: ShellWord; change: "write" }[] = [];
  let index = 0;
  for (; index < args.length; index++) {
    const text = literal(args[index]);
    if (text === undefined || !text.startsWith("-") || text === "-" || text === "--") break;
    const output = text === "-o" || text === "--output" ? args[index + 1] : text.startsWith("--output=") ? literalWord(text.slice(9)) : text.startsWith("-o") ? literalWord(text.slice(2)) : undefined;
    if (output !== undefined) writes.push({ word: output, change: "write" });
    if (["-o", "--output", "-f", "--format"].includes(text)) index++;
  }
  const words = literal(args[index]) === "{" ? [...args.slice(0, index), ...args.slice(index + 1)] : args;
  const runs = TIME_WRAPPER(words, budget).runs.map((run) => ({ ...run, added: true as const }));
  const moves = runs.some((run) => {
    if (run.name.kind !== "literal") return false;
    const timed = commandMeaning(run.name.text, run.args, budget);
    return timed.location !== undefined || timed.runs.some((each) => each.sharesShell === true);
  });
  return meaning({ reads: readsOf(args), writes, runs, unresolved: moves ? [TIME_MOVES] : [] });
}

/**
 * coproc, as the grammar gives it (recorded): an ordinary command. Under
 * bash's NAME rule, a literal NAME followed by '{', or a lone '{', makes its
 * command the words after the '{', and its body, which the grammar cuts at
 * its first ';', is also reported, unresolved code; otherwise its words are
 * the command (coproc NAME rm x runs NAME). Today's reading, its words read,
 * is kept; the command is an added run. A ( … ) body is the subshell the
 * reader's adapter walks after it.
 */
function coproc(args: readonly ShellWord[]): CommandMeaning {
  const [first, second] = args.map(literal);
  const named = first !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(first) && second === "{";
  const body = first === "{" ? 1 : named ? 2 : 0;
  const [name, ...rest] = args.slice(body);
  return meaning({ reads: readsOf(args), runs: name === undefined ? [] : [{ name, args: rest, trailing: true, added: true }], unresolved: body > 0 ? [COPROC_BODY] : [] });
}

/**
 * trap: its first operand is code the shell runs when a signal comes, walked
 * from where trap runs and from nowhere known (it runs wherever the shell is
 * then); not with -l or -p, nor when its only operand is a signal or its
 * code is '-' (a reset).
 */
function trap(args: readonly ShellWord[]): CommandMeaning {
  let index = 0;
  for (; index < args.length; index++) {
    const text = literal(args[index]);
    if (text === "--") {
      index++;
      break;
    }
    if (text === undefined || !text.startsWith("-") || text === "-") break;
    if (/[lpP]/.test(text)) return NONE;
  }
  const [code, ...signals] = args.slice(index);
  if (code === undefined || signals.length === 0 || literal(code) === "-") return NONE;
  return meaning({ scripts: [code], scriptsFromNowhereKnown: [code] });
}

/** alias: each NAME=value's value is code the shell runs where the alias is used: unresolved, and, when literal, walked from nowhere known. */
function alias(args: readonly ShellWord[]): CommandMeaning {
  const values = args.flatMap((word): ShellWord[] => {
    if (word.kind !== "literal") return word.text.includes("=") ? [word] : [];
    const equals = word.text.indexOf("=");
    return equals > 0 && !word.text.startsWith("-") ? [literalWord(word.text.slice(equals + 1))] : [];
  });
  return meaning({ unresolved: values, scriptsFromNowhereKnown: values.filter((value) => value.kind === "literal") });
}

/** . and source: the file they name is code the shell runs, which bounded does not read: reported, besides today's read of every word. */
function sourced(args: readonly ShellWord[]): CommandMeaning {
  const skipped = literal(args[0]) === "--" ? 1 : literal(args[0]) === "-p" ? 2 : 0;
  const file = args[skipped];
  return meaning({ reads: readsOf(args), unresolved: file === undefined ? [] : [file] });
}

const TEXT = [
  "echo", "printf", "true", "false", ":", "test", "[", "[[", "export", "local", "declare", "readonly", "typeset", "unset", "unalias",
  "type", "which", "hash", "set", "shopt", "exit", "return", "wait", "jobs", "kill", "sleep", "pwd", "dirs", "history", "help", "shift",
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
  sudo: wrapper(
    ["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout", "-R", "--chroot", "-a", "--auth-type", "-c", "--login-class"],
    {
      assignments: true,
      directory: ["-D", "--chdir"],
      readAsFlagsBefore: ["-R", "--chroot", "-a", "--auth-type", "-c", "--login-class"],
      shellWithoutCommand: ["-s", "--shell", "-i", "--login"],
      // sudo 1.9.17p2's long options that take no value (sudo -h): with those above, its long options are matched as getopt_long matches them.
      longFlags: ["--askpass", "--background", "--bell", "--preserve-env", "--edit", "--set-home", "--help", "--login", "--remove-timestamp", "--reset-timestamp", "--list", "--non-interactive", "--preserve-groups", "--stdin", "--shell", "--version", "--validate"],
    },
  ),
  doas: wrapper(["-u", "-C", "-a"], { readAsFlagsBefore: ["-a"], shellWithoutCommand: ["-s"] }),
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
  npx: runner(NPX),
  pnpx: runner(NPX),
  bunx: runner(BUNX),
  bun,
  pnpm: runner(PNPM),
  yarn: runner(YARN),
  uvx: runner(UVX),
  uv,
  ...Object.fromEntries(Object.entries(TEXT_PROGRAMS).map(([name, program]) => [name, textProgram(program)])),
  time,
  coproc,
  trap,
  alias,
  source: sourced,
  ".": sourced,
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

/** The table's entry for `name`, exactly as written. */
const entryOf = (name: string): ((args: readonly ShellWord[], budget: WorkBudget) => CommandMeaning) | undefined => (Object.hasOwn(TABLE, name) ? TABLE[name] : undefined);
/** A program's name as the table may also know it: its last path segment, case folded (/bin/rm, RM). */
const foldedName = (name: string): string => (name.split("/").at(-1) ?? name).toLowerCase();

/** Whether the table says what the command `name` does, by its name or its last path segment, case folded: any other reads its operands and runs nothing it can name. */
export const isKnownCommand = (name: string): boolean => entryOf(name) !== undefined || entryOf(foldedName(name)) !== undefined;

/**
 * What the command `name` does with `args`, spending from `budget`, the
 * whole command's: a step for the command and one per word. A name the table
 * does not have as written is also looked up by its last path segment, case
 * folded (/bin/rm, /usr/bin/env, RM): that meaning is added beside today's
 * (a program bounded does not know, reading its operands), and never moves
 * the shell, its directory change dropped and every run in a copy (ADR
 * 2026-020). A program the table does not know either way is uninterpreted.
 */
export function commandMeaning(name: string, args: readonly ShellWord[], budget: WorkBudget): CommandMeaning {
  // Each word costs a step and one per 64 characters; a short option cluster, read for every value it could carry, costs its suffixes' length.
  if (!spend(budget, 1 + args.length + textCost(args) + args.reduce((steps, word) => steps + clusterCost(word), 0))) return NONE;
  const known = entryOf(name);
  if (known !== undefined) return known(args, budget);
  const folded = foldedName(name);
  const found = folded === name ? undefined : entryOf(folded);
  if (found === undefined) return meaning({ reads: readsOf(args), uninterpreted: true });
  const { location: _movesTheShell, ...foundMeaning } = found(args, budget);
  const inCopies = foundMeaning.runs.map(({ sharesShell: _sharesTheShell, ...run }) => ({ ...run, added: true as const }));
  const merged = mergeMeanings([meaning({ reads: readsOf(args) }), { ...foundMeaning, runs: inCopies }], budget);
  return foundMeaning.uninterpreted === true ? { ...merged, uninterpreted: true } : merged;
}

