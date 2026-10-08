import { ProjectPath } from "bounded/domain";
import { commandMeaning, XARGS_INPUT } from "./command-meanings.ts";
import type { MeaningChange } from "./command-meanings.contract.ts";
import type { ShellCommandEffects, ShellNode, ShellPlace, ShellProgram, ShellRedirect, ShellWord, ShellWrite, UnresolvedWord } from "./shell-command.contract.ts";

// A parsed command line as the programs it runs and the project paths it
// reads, lists and writes: a translation that decides nothing. Programs are
// every one the command runs, nested and wrapped ones included, in the order
// met; the parser's stand-ins are none. Where each command runs is followed as
// the shell would: a cd carries on to later commands in the same shell, never
// out of a subshell, a substitution or a pipeline stage, and leaves where
// later commands run unknown when it may or may not have happened, or when
// its target cannot be resolved. What only the shell can resolve is
// reported as unresolved, never guessed at.

/** Where commands run: a project directory (its parts), or null when it cannot be known. */
interface Scope {
  at: readonly string[] | null;
}

const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
const sameAt = (a: readonly string[] | null, b: readonly string[] | null): boolean => a !== null && b !== null && a.join("/") === b.join("/");
const partsOf = (path: ProjectPath): string[] => (path.value === "." ? [] : path.value.split("/"));

/**
 * The roles xargs's input would have for the command `name` run with `args`
 * and then the input: where the table puts the input word, followed into a
 * command the command runs. Only a report: the input is never judged.
 */
function inputRoles(name: ShellWord, args: readonly ShellWord[], depth = 0): UnresolvedWord["role"][] {
  if (name.kind !== "literal" || depth > 8) return ["code"];
  const meaning = commandMeaning(name.text, [...args, XARGS_INPUT]);
  const has = (words: readonly ShellWord[]): boolean => words.includes(XARGS_INPUT);
  const roles: UnresolvedWord["role"][] = [];
  if (has(meaning.reads) || has(meaning.repositoryReads) || meaning.transfers.some((transfer) => has(transfer.sources))) roles.push("read");
  if (has(meaning.lists)) roles.push("list");
  if (has(meaning.writes.map(({ word }) => word)) || meaning.transfers.some((transfer) => transfer.destination === XARGS_INPUT)) roles.push("write");
  if (meaning.location?.to === XARGS_INPUT) roles.push("directory");
  if (has(meaning.scripts) || has(meaning.unresolved)) roles.push("code");
  for (const ran of meaning.runs) {
    // A command the input would name is code; a trailing run (a wrapper's command) is given the input itself, and reports it there.
    if (ran.name === XARGS_INPUT) roles.push("code");
    else if (ran.trailing !== true && has(ran.args)) roles.push(...inputRoles(ran.name, ran.args.filter((word) => word !== XARGS_INPUT), depth + 1));
  }
  return [...new Set(roles)];
}

/**
 * `words` with xargs's replace string `replace` substituted: a literal word
 * that is it becomes the input, one that holds it a word only the run can
 * resolve. A replace string only the shell can resolve substitutes nothing:
 * the words are judged as written.
 */
function substituted(words: readonly ShellWord[], replace: ShellWord): ShellWord[] {
  if (replace.kind !== "literal" || replace.text === "") return [...words];
  return words.map((word) => {
    if (word.kind !== "literal" || !word.text.includes(replace.text)) return word;
    return word.text === replace.text ? XARGS_INPUT : { kind: "unresolved" as const, text: word.text, commands: [] };
  });
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

  /** `text` as a project path from `scope`, or undefined when only the shell could resolve it. */
  const pathOf = (text: string, scope: Scope): ProjectPath | undefined => {
    let parts: string[];
    let rest = text;
    if (text.startsWith("/")) {
      if (text !== place.root && !text.startsWith(`${place.root}/`)) return undefined;
      parts = [];
      rest = text.slice(place.root.length);
    } else if (scope.at === null) return undefined;
    else parts = [...scope.at];
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
    const path = word.kind === "literal" ? pathOf(word.text, scope) : undefined;
    if (path === undefined) unresolved.push({ text: word.text, role });
    return path;
  };

  /** A write of `path`, a create or a modify by whether it exists, as a file tool's would be. */
  const write = (path: ProjectPath, change: MeaningChange): void => {
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
    if (word.kind === "unresolved") for (const node of word.commands) walk(node, { at: scope.at });
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
   * never an operand, so the literal words are judged as written.
   */
  const command = (givenName: ShellWord | null, givenArgs: readonly ShellWord[], scope: Scope, how: { readonly standIn?: boolean; readonly input?: boolean; readonly replace?: ShellWord } = {}): void => {
    if (givenName === null) return;
    // With xargs's replace string, the input stands where the string is written: it is resolved there (never judged), and the literal words around it as written.
    const [name = givenName, ...args] = how.replace === undefined ? [givenName, ...givenArgs] : substituted([givenName, ...givenArgs], how.replace);
    if (how.standIn !== true) programs.push({ name, arguments: how.input === true ? [...args, XARGS_INPUT] : args, workingDirectory: directoryOf(scope) });
    if (how.input === true) for (const role of inputRoles(name, args)) unresolved.push({ text: XARGS_INPUT.text, role });
    if (name === XARGS_INPUT) unresolved.push({ text: XARGS_INPUT.text, role: "code" });
    const meaning = commandMeaning(name.kind === "literal" ? name.text : "", args);
    for (const word of meaning.reads) {
      const path = resolve(word, scope, "read");
      if (path !== undefined) reads.push(path);
    }
    for (const word of meaning.lists) {
      const path = resolve(word, scope, "list");
      if (path !== undefined) lists.push(path);
    }
    for (const { word, change } of meaning.writes) {
      const path = resolve(word, scope, "write");
      if (path !== undefined) write(path, change);
    }
    for (const { sources, destination, moves } of meaning.transfers) {
      const to = resolve(destination, scope, "write");
      for (const source of sources) {
        const from = resolve(source, scope, "read");
        if (from !== undefined) reads.push(from);
        if (from !== undefined && moves) writes.push({ path: from, change: "delete" });
        if (to === undefined) continue;
        if (place.kindOfPath(to) !== "directory") write(to, "write");
        else if (from !== undefined) {
          const inside = pathOf(from.value.split("/").at(-1) ?? from.value, { at: partsOf(to) });
          if (inside !== undefined) write(inside, "write");
        }
      }
    }
    for (const operand of meaning.repositoryReads) {
      // The path after <rev>: is from where the command runs when written ./ or ../, else from the repository root, which is the project root only when it holds .git.
      const text = operand.text.slice(operand.text.indexOf(":") + 1);
      const fromHere = text.startsWith("./") || text.startsWith("../");
      const path = operand.kind === "literal" && (fromHere || repositoryAtRoot()) ? pathOf(text === "" ? "." : text, fromHere ? scope : { at: [] }) : undefined;
      if (path === undefined) unresolved.push({ text: operand.text, role: "read" });
      else reads.push(path);
    }
    for (const word of meaning.scripts) {
      // Code a nested shell runs: parsed and walked in a shell of its own, so its cd does not leak.
      const script = word.kind === "literal" ? place.parseScript(word.text) : undefined;
      if (script === undefined || !script.ok) unresolved.push({ text: word.text, role: "code" });
      else {
        const inside: Scope = { at: scope.at };
        for (const node of script.value) walk(node, inside);
      }
    }
    for (const word of meaning.unresolved) unresolved.push({ text: word.text, role: "code" });
    for (const ran of meaning.runs) {
      // xargs's input reaches a trailing run (sudo rm, env -C d cp a) as it reaches the command that runs it.
      const passed = { input: ran.input === true || (how.input === true && ran.trailing === true), ...(ran.replace === undefined ? {} : { replace: ran.replace }) };
      if (ran.directory === undefined) command(ran.name, ran.args, scope, passed);
      else {
        // A wrapper that sets the directory (env -C, sudo -D): the command runs from there, or from nowhere known.
        const from = ran.directory === null ? undefined : resolve(ran.directory, scope, "directory");
        command(ran.name, ran.args, { at: from === undefined ? null : partsOf(from) }, passed);
      }
    }
    if (meaning.location !== undefined) {
      const to = meaning.location.to === null ? undefined : resolve(meaning.location.to, scope, "directory");
      scope.at = to === undefined ? null : partsOf(to);
    }
  };

  const walk = (node: ShellNode, scope: Scope): void => {
    switch (node.kind) {
      case "command": {
        for (const word of [...node.assignments, ...(node.name === null ? [] : [node.name]), ...node.args, ...node.redirects.map((r) => r.target)]) substitutions(word, scope);
        command(node.name, node.args, scope, { standIn: node.standIn === true });
        for (const each of node.redirects) redirect(each, scope);
        return;
      }
      case "list": {
        if (node.operator === "&") {
          walk(node.left, { at: scope.at });
          walk(node.right, scope);
        } else if (node.operator === "||") {
          // The right side runs only when the left failed, so from where the left started.
          const before = scope.at;
          walk(node.left, scope);
          const right: Scope = { at: before };
          walk(node.right, right);
          scope.at = sameAt(scope.at, before) && sameAt(right.at, before) ? before : null;
        } else {
          walk(node.left, scope);
          walk(node.right, scope);
        }
        return;
      }
      case "pipeline":
        for (const stage of node.stages) walk(stage, { at: scope.at });
        return;
      case "subshell": {
        const inside: Scope = { at: scope.at };
        for (const inner of node.body) walk(inner, inside);
        return;
      }
      case "group":
        for (const each of node.redirects) {
          substitutions(each.target, scope);
          redirect(each, scope);
        }
        for (const inner of node.body) walk(inner, scope);
        return;
      case "conditional": {
        const maybe: Scope = { at: scope.at };
        for (const inner of node.body) walk(inner, maybe);
        if (!sameAt(maybe.at, scope.at)) scope.at = null;
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

  const start: Scope = { at: place.cwd === null ? [] : partsOf(place.cwd) };
  for (const node of script) walk(node, start);
  return { programs, reads, lists, writes, unresolved };
}
