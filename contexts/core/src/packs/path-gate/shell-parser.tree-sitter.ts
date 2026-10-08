import * as treeSitterModule from "@vscode/tree-sitter-wasm";
import type { Node } from "@vscode/tree-sitter-wasm";
import type { ShellNode, ShellParser, ShellRedirect, ShellWord } from "./shell-command.contract.ts";

// The shell parser behind the path gate's port: tree-sitter's bash grammar,
// as WebAssembly (@vscode/tree-sitter-wasm, pinned; ADR 2026-009), loaded once
// per process when a project opens, then parsing synchronously. Its syntax
// tree is mapped onto the port's own, so nothing past this file knows it.

// The package is CommonJS: its exports arrive as the default export under node's ESM loader.
const TreeSitter = (("default" in treeSitterModule ? treeSitterModule.default : treeSitterModule) as typeof treeSitterModule);
let bash: Promise<treeSitterModule.Language> | undefined;

/** The bash grammar, loaded once for the whole program. */
function loadBash(): Promise<treeSitterModule.Language> {
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
  if (SUBSTITUTIONS.has(node.type)) return [{ kind: "subshell", body: statements(node) }];
  return named(node).flatMap(substituted);
}

const unresolved = (node: Node): ShellWord => ({ kind: "unresolved", text: node.text, commands: substituted(node) });
const withoutEscapes = (text: string): string => text.replace(/\\(.)/gs, "$1");

/** A word of a command: literal when its text is fixed, else unresolved. */
function word(node: Node): ShellWord {
  switch (node.type) {
    case "word":
    case "number": {
      const text = node.text;
      if (text.startsWith("~") || GLOB.test(text) || /\{[^}]*(,|\.\.)[^}]*\}/.test(text)) return unresolved(node);
      return { kind: "literal", text: withoutEscapes(text) };
    }
    case "raw_string":
      return { kind: "literal", text: node.text.slice(1, -1) };
    case "string": {
      const parts = named(node);
      if (!parts.every((part) => part.type === "string_content")) return unresolved(node);
      return { kind: "literal", text: parts.map((part) => part.text.replace(/\\([$`"\\\n])/g, "$1")).join("") };
    }
    case "concatenation": {
      const parts = named(node).map(word);
      return parts.every((part) => part.kind === "literal") ? { kind: "literal", text: parts.map((part) => part.text).join("") } : unresolved(node);
    }
    default:
      return unresolved(node);
  }
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
  return {
    kind: "command",
    name: nameWord === null ? null : word(nameWord),
    args: nonNull(node.childrenForFieldName("argument")).map(word),
    redirects: [...nonNull(node.childrenForFieldName("redirect")).map(redirect), ...redirects],
    assignments: named(node)
      .filter((child) => child.type === "variable_assignment")
      .map((assignment) => {
        const value = assignment.childForFieldName("value");
        return value === null ? { kind: "literal" as const, text: "" } : word(value);
      }),
  };
}

/** Text the shell does not run as a command (a test, a declaration, a loop's values): only the commands substituted in it run. */
const textOnly = (node: Node, name: string): ShellNode => ({ kind: "command", name: { kind: "literal", text: name }, args: [], redirects: [], assignments: [unresolved(node)] });

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

/** Constructs whose insides may or may not run. */
const CONTROL = new Set(["if_statement", "while_statement", "for_statement", "c_style_for_statement", "case_statement", "function_definition"]);
/** The parts of those constructs that hold statements. */
const CLAUSES = new Set(["elif_clause", "else_clause", "case_item", "do_group"]);

function statement(node: Node): ShellNode | undefined {
  switch (node.type) {
    case "command":
      return command(node);
    case "redirected_statement": {
      const body = node.childForFieldName("body");
      const redirects = nonNull(node.childrenForFieldName("redirect")).map(redirect);
      if (body === null) return { kind: "command", name: null, args: [], redirects, assignments: [] };
      if (body.type === "command") return command(body, redirects);
      const inner = statement(body);
      return { kind: "group", body: inner === undefined ? [] : [inner], redirects };
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
    case "test_command":
      return textOnly(node, "[");
    case "declaration_command":
    case "unset_command":
      return textOnly(node, node.children[0]?.text ?? "declare");
    case "variable_assignment":
    case "variable_assignments":
      return textOnly(node, "true");
    default:
      if (CONTROL.has(node.type)) return { kind: "conditional", body: control(node) };
      return { kind: "unparsed", text: node.text };
  }
}

/** What runs inside an if, a loop, a case or a function: its statements, and the commands substituted in its other words. */
function control(node: Node): ShellNode[] {
  return named(node).flatMap((child): ShellNode[] => {
    if (child.type === "comment") return [];
    if (CLAUSES.has(child.type)) return control(child);
    const mapped = statement(child);
    if (mapped === undefined) return [];
    return mapped.kind === "unparsed" && child.type !== "ERROR" ? [textOnly(child, "true")] : [mapped];
  });
}

/** A new parser; prepare it once (it loads the grammar), then parse synchronously. */
export function treeSitterShellParser(): ShellParser {
  let parser: treeSitterModule.Parser | undefined;
  return {
    async prepare() {
      if (parser !== undefined) return;
      const language = await loadBash();
      const ready = new TreeSitter.Parser();
      ready.setLanguage(language);
      parser = ready;
    },
    parse(command) {
      if (parser === undefined) return { ok: false, error: "the shell parser is not prepared: a project opened with openProject prepares it" };
      const tree = parser.parse(command.value);
      if (tree === null) return { ok: false, error: "the shell parser could not parse this command" };
      try {
        return { ok: true, value: statements(tree.rootNode) };
      } finally {
        tree.delete();
      }
    },
  };
}
