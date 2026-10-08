import * as treeSitterModule from "@vscode/tree-sitter-wasm";
import type { Node } from "@vscode/tree-sitter-wasm";
import type { Command, UnreadShellCommandCause } from "bounded/domain";
import type { ShellNode, ShellRedirect, ShellWord } from "../../../domain/shell-command.contract.ts";
import { expandBraces, TOO_COSTLY } from "./brace-expansion.ts";

// The shell parser behind bounded's shell command reader: tree-sitter's bash
// grammar, as WebAssembly (@vscode/tree-sitter-wasm, pinned; ADR 2026-009),
// loaded once per process, then parsing synchronously. Its syntax tree is
// mapped onto the reader's domain's own, so nothing past this file knows it.

// The package is CommonJS: its exports arrive as the default export under node's ESM loader.
const TreeSitter = (("default" in treeSitterModule ? treeSitterModule.default : treeSitterModule) as typeof treeSitterModule);
let bash: Promise<treeSitterModule.Language> | undefined;

/** A loaded grammar, as tree-sitter gives it. */
export type BashGrammar = treeSitterModule.Language;

/**
 * A command line parsed: its syntax tree, or why it cannot be read, with a
 * cause when the command itself is to blame (too complex: brace expansion
 * that costs too much, a tree too deep, the time spent).
 */
export type ParsedCommand = { readonly ok: true; readonly value: readonly ShellNode[] } | { readonly ok: false; readonly error: string; readonly cause?: UnreadShellCommandCause };

/** A command line as the shell would run it, synchronously, within `outOfTime` (true once the time for reading it has run out). */
export interface BashSyntaxTree {
  parse(command: Command, outOfTime?: () => boolean): ParsedCommand;
}

/** The work brace expansion may do for one command, in characters passed over: far past any command written by hand. */
const BRACE_WORK_STEPS = 1_000_000;
/** How deep the syntax tree is walked: past it the command is too complex, never a stack overflow. */
const MAX_TREE_DEPTH = 1000;

/** The command being parsed: what its walk may still spend, and why it became too complex, if it did. Parsing is synchronous, so one at a time. */
let walking: { braceWorkLeft: number; depth: number; calls: number; outOfTime: () => boolean; tooComplex: string | undefined } = { braceWorkLeft: 0, depth: 0, calls: 0, outOfTime: () => false, tooComplex: undefined };

/** Why a command is unread when the time for reading it ran out; each place that looks at the time says where it was. */
const OUT_OF_TIME = "the command is too complex to read within the time bounded allows for one command";

/** Charges brace expansion `steps`; false, marking the command too complex, once its work or the time is spent. */
function chargeBraces(steps: number): boolean {
  walking.braceWorkLeft -= steps;
  if (walking.braceWorkLeft < 0) {
    walking.tooComplex ??= "the command is too complex to read: expanding its braces would take more work than bounded allows";
    return false;
  }
  if (!walking.outOfTime()) return true;
  walking.tooComplex ??= `${OUT_OF_TIME} (expanding its braces)`;
  return false;
}

/** `work` one level deeper in the tree; past MAX_TREE_DEPTH, or once the time is spent, the command is too complex and `fallback` is given. */
function deeper<T>(work: () => T, fallback: T): T {
  if (walking.tooComplex !== undefined) return fallback;
  if (walking.depth >= MAX_TREE_DEPTH) {
    walking.tooComplex = `the command is too complex to read: it nests more than ${MAX_TREE_DEPTH} levels deep`;
    return fallback;
  }
  if (++walking.calls % 64 === 1 && walking.outOfTime()) {
    walking.tooComplex = `${OUT_OF_TIME} (walking its syntax tree)`;
    return fallback;
  }
  walking.depth++;
  try {
    return work();
  } finally {
    walking.depth--;
  }
}

/** The bash grammar, loaded once for the whole program; a load that fails is tried again next time. */
export function loadBashGrammar(): Promise<BashGrammar> {
  bash ??= TreeSitter.Parser.init().then(() =>
    // A file URL: the package has no exports map, so its grammar file resolves directly.
    TreeSitter.Language.load(new URL(import.meta.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm")) as unknown as string),
  );
  bash.catch(() => {
    bash = undefined;
  });
  return bash;
}

const named = (node: Node): Node[] => node.namedChildren.filter((child): child is Node => child !== null);
const SUBSTITUTIONS = new Set(["command_substitution", "process_substitution"]);
const GLOB = /(^|[^\\])[*?[]/;

/** The commands substituted anywhere inside `node`, each run in a subshell of its own. */
function substituted(node: Node): ShellNode[] {
  return deeper(() => (SUBSTITUTIONS.has(node.type) ? [{ kind: "subshell" as const, body: statements(node) }] : named(node).flatMap(substituted)), []);
}

/** How a token tree-sitter inserted to recover from an error (of no text) is named: a reading names every part, and the shell would refuse the command. */
export const INSERTED_TOKEN = "(a token the parser inserted to recover)";

const unresolved = (node: Node): ShellWord => ({ kind: "unresolved", text: node.isMissing ? INSERTED_TOKEN : node.text, commands: substituted(node) });
const withoutEscapes = (text: string): string => text.replace(/\\(.)/gs, "$1");

/** Quoted text in a brace-expansion template: every character that could expand escaped. */
const quoted = (text: string): string => text.replace(/[\\{},.]/g, "\\$&");

const ANSI_C: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** The text of a $'…' string with simple escapes only; undefined when it holds others (\x, \u, octal, \c), which only the shell decodes. */
function ansiC(text: string): string | undefined {
  let simple = true;
  const decoded = text.slice(2, -1).replace(/\\(.)/gs, (_, char: string) => {
    const replaced = ANSI_C[char];
    if (replaced === undefined) simple = false;
    return replaced ?? "";
  });
  return simple ? decoded : undefined;
}

/**
 * A word as a brace-expansion template: unquoted text as written (its
 * escapes kept), quoted text with its characters escaped; undefined when
 * part of it only the shell can resolve (an expansion, a glob, '~').
 */
function template(node: Node): string | undefined {
  switch (node.type) {
    case "word":
    case "number":
      return node.text.startsWith("~") || GLOB.test(node.text) ? undefined : node.text;
    case "brace_expression":
      return node.text;
    case "raw_string":
      return quoted(node.text.slice(1, -1));
    case "ansi_c_string": {
      const decoded = ansiC(node.text);
      return decoded === undefined ? undefined : quoted(decoded);
    }
    case "string": {
      const parts = named(node);
      if (!parts.every((part) => part.type === "string_content")) return undefined;
      return quoted(parts.map((part) => part.text.replace(/\\([$`"\\\n])/g, "$1")).join(""));
    }
    case "concatenation": {
      const parts = named(node).map(template);
      return parts.every((part) => part !== undefined) ? parts.join("") : undefined;
    }
    default:
      return undefined;
  }
}

/** The words a word becomes: its brace expansion, each literal; one unresolved word when the shell alone can say. */
function words(node: Node): ShellWord[] {
  // A token the parser inserted is no word written: never a literal (such as an empty command name).
  if (node.isMissing) return [unresolved(node)];
  const text = template(node);
  // Quoted and escaped braces arrive escaped in the template, so only text that can expand costs expansion work.
  const expanded = text === undefined ? undefined : expandBraces(text, chargeBraces);
  if (expanded === undefined || expanded === TOO_COSTLY) return [unresolved(node)];
  return expanded.map((each) => ({ kind: "literal", text: withoutEscapes(each) }));
}

/** One word: a word that expands to several is one only the shell can make sense of here (a redirection's target, an assignment's value). */
function word(node: Node): ShellWord {
  const all = words(node);
  return all.length === 1 && all[0] !== undefined ? all[0] : unresolved(node);
}

function redirect(node: Node): ShellRedirect {
  if (node.type === "heredoc_redirect") return { operator: "<<", target: unresolved(node) };
  if (node.type === "herestring_redirect") return { operator: "<<<", target: unresolved(node) };
  const operator = node.children.find((child) => child !== null && !child.isNamed)?.text ?? "";
  const destination = node.childForFieldName("destination");
  return { operator, target: destination === null ? unresolved(node) : word(destination) };
}

const nonNull = (nodes: (Node | null)[]): Node[] => nodes.filter((node): node is Node => node !== null);

function command(node: Node, redirects: readonly ShellRedirect[] = []): ShellNode {
  const name = node.childForFieldName("name");
  const nameWord = name === null ? null : (named(name)[0] ?? name);
  // The name's own expansion runs as the command and its first arguments, as in {cat,.env}.
  const [first = null, ...more] = nameWord === null ? [] : words(nameWord);
  return {
    kind: "command",
    name: first,
    args: [...more, ...nonNull(node.childrenForFieldName("argument")).flatMap(words)],
    redirects: [...nonNull(node.childrenForFieldName("redirect")).map(redirect), ...redirects],
    assignments: named(node)
      .filter((child) => child.type === "variable_assignment")
      .map((assignment) => {
        const value = assignment.childForFieldName("value");
        return value === null ? { kind: "literal" as const, text: "" } : word(value);
      }),
  };
}

/** A builtin whose words are text, not paths (a test, a declaration): the program runs, and only the commands substituted in it run besides. */
const textOnly = (node: Node, name: string): ShellNode => ({ kind: "command", name: { kind: "literal", text: name }, args: [], redirects: [], assignments: [unresolved(node)] });
/** Text the shell does not run as a command (a loop's values, an assignment): a stand-in, no program; only the commands substituted in it run. */
const standIn = (node: Node): ShellNode => ({ kind: "command", name: { kind: "literal", text: "true" }, args: [], redirects: [], assignments: [unresolved(node)], standIn: true });

/** The statements inside `node`, in order; a statement followed by '&' runs in the background, in a subshell. */
function statements(node: Node): ShellNode[] {
  const out: ShellNode[] = [];
  const children = node.children;
  for (const [index, child] of children.entries()) {
    if (child === null || !child.isNamed || child.type === "comment") continue;
    const mapped = statement(child);
    if (mapped === undefined) continue;
    out.push(children[index + 1]?.type === "&" ? { kind: "subshell", body: [mapped] } : mapped);
  }
  return out;
}

/** `node` with `redirects` given to its last command, as the shell gives a list's or a pipeline's trailing redirections; around it as a group when its last part is no simple command. */
function lastRedirected(node: ShellNode, redirects: readonly ShellRedirect[]): ShellNode {
  if (node.kind === "command") return { ...node, redirects: [...node.redirects, ...redirects] };
  if (node.kind === "list") return { ...node, right: lastRedirected(node.right, redirects) };
  const last = node.kind === "pipeline" ? node.stages.at(-1) : undefined;
  if (node.kind === "pipeline" && last !== undefined) return { ...node, stages: [...node.stages.slice(0, -1), lastRedirected(last, redirects)] };
  return { kind: "group", body: [node], redirects };
}

/** Constructs whose insides may or may not run. */
const CONTROL = new Set(["if_statement", "while_statement", "for_statement", "c_style_for_statement", "case_statement", "function_definition"]);
/** The parts of those constructs that hold statements. */
const CLAUSES = new Set(["elif_clause", "else_clause", "case_item", "do_group"]);

/** A statement, one level deeper in the tree (bounded: see `deeper`). */
function statement(node: Node): ShellNode | undefined {
  return deeper(() => statementAt(node), { kind: "unparsed", text: "" });
}

function statementAt(node: Node): ShellNode | undefined {
  switch (node.type) {
    case "command":
      return command(node);
    case "redirected_statement": {
      const body = node.childForFieldName("body");
      const redirects = nonNull(node.childrenForFieldName("redirect")).map(redirect);
      if (body === null) return { kind: "command", name: null, args: [], redirects, assignments: [] };
      if (body.type === "command") return command(body, redirects);
      const inner = statement(body);
      if (inner === undefined) return { kind: "group", body: [], redirects };
      // The grammar hangs a redirection after `a && b` (or `a | b`) on the whole list; the shell gives it to the last command, which runs where the list has taken it.
      return body.type === "list" || body.type === "pipeline" ? lastRedirected(inner, redirects) : { kind: "group", body: [inner], redirects };
    }
    case "list": {
      const [left, right] = named(node).map(statement);
      const operator = node.children.find((child) => child !== null && !child.isNamed)?.text;
      if (left === undefined || right === undefined || (operator !== "&&" && operator !== "||" && operator !== ";" && operator !== "&")) return { kind: "unparsed", text: node.text };
      return { kind: "list", left, operator, right };
    }
    case "pipeline":
      return { kind: "pipeline", stages: named(node).flatMap((stage) => statement(stage) ?? []) };
    case "subshell":
      return { kind: "subshell", body: statements(node) };
    case "compound_statement":
      return { kind: "group", body: statements(node), redirects: [] };
    case "negated_command": {
      const [inner] = named(node);
      return inner === undefined ? undefined : statement(inner);
    }
    case "file_redirect":
    case "heredoc_redirect":
    case "herestring_redirect":
      // A redirection alone, as in $(< file).
      return { kind: "command", name: null, args: [], redirects: [redirect(node)], assignments: [] };
    case "test_command":
      return textOnly(node, "[");
    case "declaration_command":
    case "unset_command":
      return textOnly(node, node.children[0]?.text ?? "declare");
    case "variable_assignment":
    case "variable_assignments":
      return standIn(node);
    default:
      if (CONTROL.has(node.type)) return { kind: "conditional", body: control(node) };
      return { kind: "unparsed", text: node.text };
  }
}

/** What runs inside an if, a loop, a case or a function: its statements, and the commands substituted in its other words. */
function control(node: Node): ShellNode[] {
  return named(node).flatMap((child): ShellNode[] => {
    if (child.type === "comment") return [];
    if (CLAUSES.has(child.type)) return deeper(() => control(child), []);
    const mapped = statement(child);
    if (mapped === undefined) return [];
    return mapped.kind === "unparsed" && child.type !== "ERROR" ? [standIn(child)] : [mapped];
  });
}

/** A parser over the grammar `loadGrammar` gives (by default bash's, loaded once per process), ready to parse synchronously. Rejects when the grammar cannot load. */
export async function bashSyntaxTree(loadGrammar: () => Promise<BashGrammar> = loadBashGrammar): Promise<BashSyntaxTree> {
  const grammar = await loadGrammar();
  const parser = new TreeSitter.Parser();
  parser.setLanguage(grammar);
  return Object.freeze({
    parse(command: Command, outOfTime: () => boolean = () => false): ParsedCommand {
      const parsingTooLong = { ok: false as const, error: `${OUT_OF_TIME} (parsing it)`, cause: "too-complex" as const };
      if (outOfTime()) return parsingTooLong;
      // Tree-sitter asks, as it goes, whether to stop: once the time has run out, it stops and gives no tree.
      const tree = parser.parse(command.value, null, { progressCallback: () => outOfTime() });
      if (tree === null) {
        // The parser is shared across reads: a cancelled parse must not leave it resuming this one.
        parser.reset();
        if (outOfTime()) return parsingTooLong;
        // Otherwise the parser itself failed: nothing about the command to fix, so no cause.
        return { ok: false, error: "the shell parser could not parse this command" };
      }
      const outer = walking;
      walking = { braceWorkLeft: BRACE_WORK_STEPS, depth: 0, calls: 0, outOfTime, tooComplex: undefined };
      try {
        const value = statements(tree.rootNode);
        if (walking.tooComplex !== undefined) return { ok: false, error: walking.tooComplex, cause: "too-complex" };
        return { ok: true, value };
      } finally {
        walking = outer;
        tree.delete();
      }
    },
  });
}
