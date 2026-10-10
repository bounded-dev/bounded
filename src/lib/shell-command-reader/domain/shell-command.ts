import { ProjectPath } from "bounded/domain";
import { commandMeaning, FOUND_PATH, isKnownCommand, MAX_NESTING, mergeMeanings, newWorkBudget, PIPED_INPUT, STANDARD_INPUT, shellArgumentsMeaning, spend, textCost, WORK_BUDGET_STEPS, WORKING_TREE, XARGS_INPUT } from "./command-meanings.ts";
import type { CommandMeaning, MeaningChange } from "./command-meanings.contract.ts";
import type { PathKind, ShellCommandEffects, ShellNode, ShellPlace, ShellProgram, ShellRedirect, ShellWord, ShellWrite, UnresolvedWord, WorkBudget } from "./shell-command.contract.ts";

// A parsed command line as the programs it runs and the project paths it
// reads, lists and writes: a translation that decides nothing. Programs are
// the runs the reader knows, nested and wrapped ones included, in the order
// met (never what a program or script runs itself; ADR 2026-020 names what is
// not listed); the parser's stand-ins are none. Where each command runs is followed as
// the shell would: a cd carries on to later commands in the same shell, never
// out of a subshell, a substitution or a pipeline stage, and leaves where
// later commands run unknown when it may or may not have happened, or when
// its target cannot be resolved. What only the shell can resolve is
// reported as unresolved, never guessed at. Every reading adds: where a word
// only the shell can resolve could be read more than one way, each reading is
// walked beside today's, never in its stead, and only a run in the same shell
// (builtin, command, exec) moves where later commands run (ADR 2026-020).

/**
 * Where commands run: a project directory (its parts), or null when it
 * cannot be known, and the characters carrying it costs (each directory's
 * and one more each), counted once when it is made, so the cost is O(1).
 */
interface Scope {
  readonly at: readonly string[] | null;
  readonly joinedLength: number;
}

/** The only way to make a scope. */
const scopeAt = (at: readonly string[] | null): Scope => Object.freeze({ at, joinedLength: at === null ? 0 : at.reduce((characters, directory) => characters + directory.length + 1, 0) });

/** Where a shell runs now: a cd replaces the scope it holds. A copy is a new cell with the same scope, so a cd in it never reaches the original. */
interface ScopeCell {
  current: Scope;
}
const cellAt = (scope: Scope): ScopeCell => ({ current: scope });

/**
 * How many arguments a listed-only suffix reading carries (a word the table
 * does not know, after a program only the shell can name): its leading
 * words, as many as a rule may match against (bounded/prereqs' program
 * prefixes hold at most 16 words); every argument is still in the
 * program's own run and reading (ADR 2026-020).
 */
const LISTED_SUFFIX_ARGUMENTS = 16;

/**
 * What in a literal word makes it shell code to a program that runs its
 * arguments through a shell (ssh, watch): '$' (`$(` too), a backquote, ';',
 * '|' (`||` too), '&&' or a newline (ADR 2026-020).
 */
const SHELL_SYNTAX = /[$`;|\n]|&&/;

/** Why a command that outgrew its work budget is unread. */
const TOO_COMPLEX = `the command is too complex to read within bounded's work budget (${WORK_BUDGET_STEPS} steps): its words could be read too many ways, or it nests too deep`;
/** Why a command whose reading ran out of time is unread. */
const OUT_OF_TIME = "the command is too complex to read within the time bounded allows for one command (reading what it does)";

const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
const sameAt = (a: readonly string[] | null, b: readonly string[] | null): boolean => a !== null && b !== null && a.join("/") === b.join("/");
const partsOf = (path: ProjectPath): string[] => (path.value === "." ? [] : path.value.split("/"));
/** What carrying where a scope runs costs (it is copied, joined and compared): a step per 8 characters of its joined path, so one long directory name costs as many directories do; read from the scope, so asking costs nothing more. */
const joinedPathCost = (scope: Scope): number => Math.floor(scope.joinedLength / 8);

/**
 * The roles an input would have for the command `name` run with `words`,
 * among which the input stands as `input` (xargs's XARGS_INPUT after them,
 * or where a replace string is; find's FOUND_PATH where {} is): where the
 * table puts the input word, followed into a command the command runs. Only
 * a report: the words are judged as written, never these. `withMeaning`
 * is given the meaning the table gives the command, when it is looked up,
 * so a caller that needs it too does not look it up, nor pay for it, again.
 */
function inputRoles(
  name: ShellWord,
  words: readonly ShellWord[],
  budget: WorkBudget,
  input: ShellWord = XARGS_INPUT,
  depth = 0,
  withMeaning: (meaning: CommandMeaning) => void = () => {},
): UnresolvedWord["role"][] {
  if (!spend(budget, 1 + words.length)) return [];
  if (name === input) return ["code"];
  if (name.kind !== "literal" || depth > 8) return ["code"];
  const meaning = commandMeaning(name.text, words, budget);
  withMeaning(meaning);
  const has = (words: readonly ShellWord[]): boolean => words.includes(input);
  const roles: UnresolvedWord["role"][] = [];
  if (has(meaning.reads) || has(meaning.repositoryReads) || meaning.transfers.some((transfer) => has(transfer.sources))) roles.push("read");
  if (has(meaning.lists)) roles.push("list");
  // A moved source is deleted, so it is written too.
  if (has(meaning.writes.map(({ word }) => word)) || meaning.transfers.some((transfer) => transfer.destination === input || (transfer.moves && has(transfer.sources)))) roles.push("write");
  if (meaning.location?.to === input) roles.push("directory");
  if (has(meaning.scripts) || has(meaning.unresolved)) roles.push("code");
  // xargs's input to a program the table does not know may be anything it makes of it: code too (ADR 2026-020).
  if (meaning.uninterpreted === true && input === XARGS_INPUT) roles.push("code");
  for (const ran of meaning.runs) {
    // A command the input would name is code; a trailing run (a wrapper's command) is given the input itself, and reports it there.
    if (ran.name === input) roles.push("code");
    else if (ran.trailing !== true && has(ran.args)) roles.push(...inputRoles(ran.name, ran.args, budget, input, depth + 1));
  }
  return [...new Set(roles)];
}

/**
 * Where an input stands with replace string `replace`: each literal word
 * that is it or holds it, as `input` (xargs's XARGS_INPUT, find's
 * FOUND_PATH); for reporting the input's roles and listing the program's
 * words only, never for judging. A replace string only the shell can resolve
 * stands nowhere known: the input is reported as code.
 */
function withInputReplaced(words: readonly ShellWord[], replace: ShellWord, input: ShellWord): ShellWord[] | undefined {
  if (replace.kind !== "literal" || replace.text === "") return undefined;
  return words.map((word) => (word.kind === "literal" && word.text.includes(replace.text) ? input : word));
}

/** Where a scope runs, as a project path ("." for the root), or null when it cannot be known. */
function directoryOf(scope: Scope): ProjectPath | null {
  if (scope.at === null) return null;
  const path = ProjectPath.parse(scope.at.length === 0 ? "." : scope.at.join("/"));
  return path.ok ? path.value : null;
}

/** What `script`, run at `place`, runs, reads, lists and writes. */
export function describeShellCommand(script: readonly ShellNode[], place: ShellPlace): ShellCommandEffects {
  const reads: ProjectPath[] = [];
  const lists: ProjectPath[] = [];
  const writes: ShellWrite[] = [];
  const unresolved: UnresolvedWord[] = [];
  const programs: ShellProgram[] = [];
  // One budget for the whole command: every command, xargs reading and report of xargs's input spends from it, and nesting is bounded.
  const budget = newWorkBudget(place.outOfTime);
  let nesting = 0;
  /** `work`, one level deeper; past MAX_NESTING the budget is spent, so the command is unread. */
  const nested = (work: () => void): void => {
    if (nesting >= MAX_NESTING) {
      budget.exhausted = true;
      return;
    }
    nesting++;
    try {
      work();
    } finally {
      nesting--;
    }
  };

  /** `text` as a project path from the directory `at` (its parts; null when it cannot be known), or undefined when only the shell could resolve it. */
  const pathOf = (text: string, at: readonly string[] | null): ProjectPath | undefined => {
    let parts: string[];
    let rest = text;
    if (text.startsWith("/")) {
      if (text !== place.root && !text.startsWith(`${place.root}/`)) return undefined;
      parts = [];
      rest = text.slice(place.root.length);
    } else if (at === null) return undefined;
    else parts = [...at];
    for (const part of rest.split("/")) {
      if (part === "" || part === ".") continue;
      if (part !== "..") parts.push(part);
      else if (parts.pop() === undefined) return undefined;
    }
    const path = ProjectPath.parse(parts.length === 0 ? "." : parts.join("/"));
    return path.ok ? path.value : undefined;
  };

  /** A word as a project path; recorded as unresolved, with the role it would have had, when it cannot be one. */
  const resolve = (word: ShellWord, scope: Scope, role: UnresolvedWord["role"]): ProjectPath | undefined => {
    // Resolving costs a step and one more per 64 characters; once the budget is spent nothing more is kept.
    if (!spend(budget, 1 + (word.text.length >> 6) + joinedPathCost(scope))) return undefined;
    const path = word.kind === "literal" ? pathOf(word.text, scope.at) : undefined;
    if (path === undefined) unresolved.push({ text: word.text, role });
    return path;
  };

  /** A write of `path`, a create or a modify by whether it exists, as a file tool's would be. */
  const write = (path: ProjectPath, change: MeaningChange): void => {
    if (!spend(budget)) return;
    if (change === "create" || change === "delete") {
      writes.push({ path, change });
      return;
    }
    const kind = place.kindOfPath(path);
    if (kind === undefined) {
      writes.push({ path, change: "create", undetermined: true });
      if (change === "write") writes.push({ path, change: "modify", undetermined: true });
    } else if (kind === "absent") writes.push({ path, change: "create" });
    else if (change === "write") writes.push({ path, change: "modify" });
  };

  /** The commands substituted in a word run in subshells of their own. */
  const substitutions = (word: ShellWord, scope: Scope): void => {
    if (word.kind === "unresolved") nested(() => {
      for (const node of word.commands) walk(node, cellAt(scope));
    });
  };

  const redirect = ({ operator, target }: ShellRedirect, scope: Scope): void => {
    if (operator === "<" || operator === "<>") {
      const path = resolve(target, scope, "read");
      if (path !== undefined) reads.push(path);
    }
    const duplicates = (operator === ">&" || operator === "<&") && /^(\d+|-)$/.test(target.kind === "literal" ? target.text : "");
    if (WRITE_REDIRECTS.has(operator) || operator === "<>" || (operator === ">&" && !duplicates)) {
      const path = resolve(target, scope, "write");
      if (path !== undefined) write(path, "write");
    }
  };

  /**
   * A simple command: a program (unless the parser's stand-in), then what it
   * does with its literal words. With `input` (xargs without a replace
   * string), more arguments come from its input: they are the program's
   * last argument and an unresolved part with each role they could have,
   * never an operand, so the literal words are judged as written. With
   * `replace` (xargs's replace string, or find -exec's {}), the input
   * (`replacedBy`: xargs's (input), find's (found path)) stands where the
   * string is written: each word holding it is listed as the input among the
   * program's words, and reported as an unresolved part with each role the
   * command gives it, and every word is still judged as written (a
   * substitution adds a report, never replaces the check). `fed` is what
   * reaches its standard input that bounded cannot see (piped input, a
   * here-string): to a program the table does not know it is code, as is a
   * word only the shell can resolve (ADR 2026-020).
   */
  const command = (
    name: ShellWord | null,
    args: readonly ShellWord[],
    cell: ScopeCell,
    how: { readonly standIn?: boolean; readonly input?: boolean; readonly replace?: ShellWord; readonly replacedBy?: ShellWord; readonly written?: boolean; readonly fed?: readonly ShellWord[] } = {},
  ): void => {
    const scope = cell.current;
    if (name === null || !spend(budget, 1 + args.length + joinedPathCost(scope))) return;
    const replacedBy = how.replacedBy ?? XARGS_INPUT;
    const charged = how.replace !== undefined && spend(budget, 1 + args.length + textCost(args));
    const replaced = charged && how.replace !== undefined ? withInputReplaced([name, ...args], how.replace, replacedBy) : undefined;
    const [listedName = name, ...listedArgs] = replaced ?? [name, ...args];
    if (how.standIn !== true) programs.push({ name: listedName, arguments: how.input === true ? [...listedArgs, XARGS_INPUT] : listedArgs, workingDirectory: directoryOf(scope) });
    let withInput: CommandMeaning | undefined;
    if (how.input === true) {
      const roles = inputRoles(name, [...args, XARGS_INPUT], budget, XARGS_INPUT, 0, (meaning) => {
        withInput = meaning;
      });
      for (const role of roles) unresolved.push({ text: XARGS_INPUT.text, role });
    }
    if (charged) {
      const [inputName = name, ...inputArgs] = replaced ?? [replacedBy];
      const roles = inputName === name && !inputArgs.includes(replacedBy) ? [] : inputRoles(inputName, inputArgs, budget, replacedBy);
      for (const role of roles) unresolved.push({ text: replacedBy.text, role });
    }
    // Where xargs's input would be a source of a copy or move into a directory, or a path of unknown kind, it is written there too.
    // The meaning is the one the input's roles were read from: looked up, and charged, once.
    if (withInput !== undefined) intoDestinations(withInput.transfers, XARGS_INPUT, scope);
    // A program whose name only the shell can resolve, written in the script (or run from one so written), may be a wrapper or a shell:
    // its words are also read as a shell's arguments here, and every literal-led suffix of them as a command, below (ADR 2026-020).
    const variableNamed = how.written === true && how.standIn !== true && name.kind === "unresolved" && name !== XARGS_INPUT && name !== FOUND_PATH;
    const own = commandMeaning(name.kind === "literal" ? name.text : "", args, budget);
    const meaning = variableNamed ? mergeMeanings([own, shellArgumentsMeaning(args, budget)], budget) : own;
    for (const word of meaning.reads) {
      const path = resolve(word, scope, "read");
      if (path !== undefined) reads.push(path);
    }
    // A program the table does not know may run what reaches it: a word only the shell can resolve, a literal word holding shell
    // syntax (ssh and watch run it as shell code), piped input and a here-string are code, each charged its text (the scan included).
    if (name.kind === "literal" && how.standIn !== true && own.uninterpreted === true) {
      for (const word of [...args, ...(how.fed ?? [])]) {
        if (!spend(budget, 1 + textCost([word]))) break;
        if (word.kind === "unresolved" || SHELL_SYNTAX.test(word.text)) unresolved.push({ text: word.text, role: "code" });
      }
    }
    for (const word of meaning.lists) {
      const path = resolve(word, scope, "list");
      if (path !== undefined) lists.push(path);
    }
    for (const { word, change, pathspec } of meaning.writes) {
      const path = resolve(word, scope, "write");
      if (path !== undefined) write(path, change);
      // A pathspec naming a directory reaches every file beneath it: the working tree is written.
      if (path !== undefined && pathspec === true && spend(budget) && place.kindOfPath(path) === "directory") unresolved.push({ text: WORKING_TREE.text, role: "write" });
    }
    for (const { sources, destination, moves } of meaning.transfers) {
      const to = resolve(destination, scope, "write");
      for (const source of sources) {
        const from = resolve(source, scope, "read");
        if (from !== undefined) reads.push(from);
        if (from !== undefined && moves) writes.push({ path: from, change: "delete" });
        // A moved source only the shell can name is deleted, wherever it goes.
        if (from === undefined && moves && spend(budget)) unresolved.push({ text: source.text, role: "write" });
        if (to === undefined || !spend(budget)) continue;
        const kind = place.kindOfPath(to);
        if (kind !== "directory") write(to, "write");
        if (from === undefined) into(to, kind, source);
        else if (kind === "directory") {
          const inside = pathOf(from.value.split("/").at(-1) ?? from.value, partsOf(to));
          if (inside !== undefined) write(inside, "write");
        }
      }
    }
    for (const operand of meaning.repositoryReads) {
      if (!spend(budget, 2)) break;
      // The path after <rev>: is from where the command runs when written ./ or ../, else from the repository root, which is the project root only when it holds .git.
      const text = operand.text.slice(operand.text.indexOf(":") + 1);
      const fromHere = text.startsWith("./") || text.startsWith("../");
      const path = operand.kind === "literal" && (fromHere || repositoryAtRoot()) ? pathOf(text === "" ? "." : text, fromHere ? scope.at : []) : undefined;
      if (path === undefined) unresolved.push({ text: operand.text, role: "read" });
      else reads.push(path);
    }
    for (const word of meaning.scripts) {
      // Parsing a nested shell's code costs in proportion to its length, each time it is parsed.
      if (!spend(budget, 1 + (word.text.length >> 4))) break;
      // Code a nested shell runs: parsed and walked in a shell of its own, so its cd does not leak.
      const script = word.kind === "literal" ? place.parseScript(word.text) : undefined;
      if (script === undefined || !script.ok) unresolved.push({ text: word.text, role: "code" });
      else {
        const inside = cellAt(scope);
        nested(() => {
          for (const node of script.value) walk(node, inside);
        });
      }
    }
    // Code that runs later, wherever the shell is then (trap's, an alias's): walked from nowhere known, unless the scripts above were walked from there already.
    for (const word of meaning.scriptsFromNowhereKnown ?? []) {
      if (word.kind !== "literal" || (scope.at === null && meaning.scripts.some((each) => each.kind === "literal" && each.text === word.text))) continue;
      if (!spend(budget, 1 + (word.text.length >> 4))) break;
      const script = place.parseScript(word.text);
      if (!script.ok) unresolved.push({ text: word.text, role: "code" });
      else {
        const nowhere = cellAt(scopeAt(null));
        nested(() => {
          for (const node of script.value) walk(node, nowhere);
        });
      }
    }
    for (const word of meaning.unresolved) unresolved.push({ text: word.text, role: "code" });
    // A shell's script naming no project path from here may be its standard input (a link to /dev/stdin): fail closed.
    const outside = (meaning.standardInputUnlessInProject ?? []).some((word) => word.kind === "literal" && pathOf(word.text, scope.at) === undefined);
    if (outside) unresolved.push({ text: STANDARD_INPUT.text, role: "code" });
    // xargs's runs are its own readings, never written ones: its every-reading rule already reads them.
    const runsWritten = how.written === true && !(name.kind === "literal" && name.text === "xargs");
    for (const ran of meaning.runs) {
      // xargs's input reaches a trailing run (sudo rm, env -C d cp a) as it reaches the command that runs it.
      const inherited = ran.replace === undefined && ran.trailing === true;
      const replace = inherited ? how.replace : ran.replace;
      const replacedBy = inherited ? how.replacedBy : ran.replacedBy;
      // What reaches the command's standard input reaches a trailing run (sudo mytool) too.
      const fed = ran.trailing === true ? how.fed : undefined;
      const passed = {
        input: ran.input === true || (how.input === true && ran.trailing === true),
        ...(replace === undefined ? {} : { replace }),
        ...(replacedBy === undefined ? {} : { replacedBy }),
        ...(fed === undefined ? {} : { fed }),
        written: runsWritten,
      };
      // A run added from nowhere known (find -execdir's) where the shell is nowhere known already is the run beside it: read once.
      const alsoHere = (other: CommandMeaning["runs"][number]): boolean => other !== ran && other.directory === undefined && other.name === ran.name && other.args === ran.args;
      if (ran.directory === null && ran.added === true && cell.current.at === null && meaning.runs.some(alsoHere)) continue;
      // Only a run in the same shell (builtin, command, exec) moves where later commands run; any other runs in a copy.
      if (ran.directory === undefined) nested(() => command(ran.name, ran.args, ran.sharesShell === true ? cell : cellAt(cell.current), passed));
      else {
        // A wrapper that sets the directory (env -C, sudo -D): the command runs from there, or from nowhere known.
        const from = ran.directory === null ? undefined : resolve(ran.directory, cell.current, "directory");
        nested(() => command(ran.name, ran.args, cellAt(scopeAt(from === undefined ? null : partsOf(from))), passed));
      }
    }
    if (variableNamed) {
      // Each literal-led suffix of its words, as a command of its own, in a copy: the program may be a wrapper (sudo, env …).
      const suffix = { ...(how.replace === undefined ? {} : { replace: how.replace }), ...(how.replacedBy === undefined ? {} : { replacedBy: how.replacedBy }), written: true };
      const listedSuffixes = new Set<string>();
      for (let index = 0; index < args.length; index++) {
        const word = args[index] as ShellWord;
        if (word.kind !== "literal") continue;
        if (isKnownCommand(word.text) || word.text === "--") {
          // A command the table knows (or one led by --, after which options read as options again) is walked whole, charged its words.
          const rest = args.slice(index + 1);
          if (!spend(budget, 1 + rest.length)) break;
          nested(() => command(word, rest, cellAt(cell.current), suffix));
          continue;
        }
        // A command the table does not know reads its operands, which the program's own reading of the same words already reads, and
        // runs nothing it can name: it is listed with at most LISTED_SUFFIX_ARGUMENTS of its arguments, charged what it stores, so the
        // work and the reading's size both grow linearly with the command's words.
        const kept = args.slice(index + 1, index + 1 + LISTED_SUFFIX_ARGUMENTS);
        if (!spend(budget, 1 + kept.length + textCost([word, ...kept]))) break;
        const listed = how.replace === undefined ? kept : (withInputReplaced(kept, how.replace, how.replacedBy ?? XARGS_INPUT) ?? kept);
        // A suffix listed exactly as one before it (a a a … gives a [a …] again and again) adds nothing: listed once.
        const key = JSON.stringify([word.text, listed.map((each) => [each.kind, each.text])]);
        if (listedSuffixes.has(key)) continue;
        listedSuffixes.add(key);
        programs.push({ name: word, arguments: listed, workingDirectory: directoryOf(cell.current) });
      }
    }
    if (meaning.location !== undefined) {
      const to = meaning.location.to === null ? undefined : resolve(meaning.location.to, cell.current, "directory");
      cell.current = scopeAt(to === undefined ? null : partsOf(to));
    }
  };

  /**
   * A copy or move of `source`, which only the shell can name, into `to`: a
   * directory, or a path whose kind cannot be told, may receive it under its
   * own name, so that write is reported, unresolved (ADR 2026-020).
   */
  const into = (to: ProjectPath, kind: PathKind | undefined, source: ShellWord): void => {
    if (kind !== "directory" && kind !== undefined) return;
    const text = to.value === "." ? source.text : `${to.value}/${source.text}`;
    // A step, and one more per 64 characters of the text it reports.
    if (spend(budget, 1 + (text.length >> 6))) unresolved.push({ text, role: "write" });
  };

  /** The transfers whose sources hold `input` (xargs's), each into its destination when that resolves from `scope`. */
  const intoDestinations = (transfers: CommandMeaning["transfers"], input: ShellWord, scope: Scope): void => {
    for (const { sources, destination } of transfers) {
      if (!sources.includes(input) || !spend(budget, 1 + joinedPathCost(scope))) continue;
      const to = destination.kind === "literal" ? pathOf(destination.text, scope.at) : undefined;
      if (to !== undefined) into(to, place.kindOfPath(to), input);
    }
  };

  /** Walks `node` from `cell`; `piped` when a pipe feeds it (a pipeline's stage after the first, and every command inside one). */
  const walk = (node: ShellNode, cell: ScopeCell, piped = false): void => {
    if (!spend(budget, 1 + joinedPathCost(cell.current))) return;
    switch (node.kind) {
      case "command": {
        for (const word of [...node.assignments, ...(node.name === null ? [] : [node.name]), ...node.args, ...node.redirects.map((r) => r.target)]) substitutions(word, cell.current);
        const fed = [...(piped ? [PIPED_INPUT] : []), ...node.redirects.filter((each) => each.operator === "<<<").map((each) => each.target)];
        command(node.name, node.args, cell, { standIn: node.standIn === true, written: true, ...(fed.length === 0 ? {} : { fed }) });
        for (const each of node.redirects) redirect(each, cell.current);
        return;
      }
      case "list": {
        if (node.operator === "&") {
          walk(node.left, cellAt(cell.current), piped);
          walk(node.right, cell, piped);
        } else if (node.operator === "||") {
          // The right side runs only when the left failed, so from where the left started.
          const before = cell.current;
          walk(node.left, cell, piped);
          const right = cellAt(before);
          walk(node.right, right, piped);
          cell.current = sameAt(cell.current.at, before.at) && sameAt(right.current.at, before.at) ? before : scopeAt(null);
        } else {
          walk(node.left, cell, piped);
          walk(node.right, cell, piped);
        }
        return;
      }
      case "pipeline":
        for (const [index, stage] of node.stages.entries()) walk(stage, cellAt(cell.current), piped || index > 0);
        return;
      case "subshell": {
        const inside = cellAt(cell.current);
        for (const inner of node.body) walk(inner, inside, piped);
        return;
      }
      case "group":
        for (const each of node.redirects) {
          substitutions(each.target, cell.current);
          redirect(each, cell.current);
        }
        for (const inner of node.body) walk(inner, cell, piped);
        return;
      case "conditional": {
        const maybe = cellAt(cell.current);
        for (const inner of node.body) walk(inner, maybe, piped);
        if (!sameAt(maybe.current.at, cell.current.at)) cell.current = scopeAt(null);
        return;
      }
      case "unparsed":
        unresolved.push({ text: node.text, role: "code" });
        return;
    }
  };

  /** Whether the project root is the repository's root: it holds .git. */
  const repositoryAtRoot = (): boolean => {
    const git = ProjectPath.parse(".git");
    const kind = git.ok ? place.kindOfPath(git.value) : undefined;
    return kind !== undefined && kind !== "absent";
  };

  const start = cellAt(scopeAt(place.cwd === null ? [] : partsOf(place.cwd)));
  for (const node of script) walk(node, start);
  // A last look at the time: a reading finished past it is not trusted either.
  if (!budget.exhausted && budget.outOfTime()) {
    budget.exhausted = true;
    budget.timedOut = true;
  }
  const workSpent = WORK_BUDGET_STEPS - Math.max(budget.left, 0);
  if (budget.exhausted) return { programs: [], reads: [], lists: [], writes: [], unresolved: [], unreadWhy: budget.timedOut ? OUT_OF_TIME : TOO_COMPLEX, workSpent };
  return { programs, reads, lists, writes, unresolved, workSpent };
}
