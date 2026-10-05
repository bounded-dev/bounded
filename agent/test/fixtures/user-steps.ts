// The detector behind "a project's user never runs harness steps" (AGENTS.md;
// ADR 2026-072), shared by the drift test over role briefs and skills
// (src/user-steps-drift.test.ts) and the refusal test over the harness's own
// source strings (src/user-refusals.test.ts).
//
// A sentence addresses the user when it says "user", or when it follows one
// that does and refers back with "they", "them" or "their". Read `strict`,
// every line of an output routed to the user (`route → user`) addresses the
// user, whatever it says. In such a sentence, a command is:
//
//   · a backticked span that starts with `!`, or whose first token is a
//     lowercase word (not a label ending in a colon) followed by at least one
//     more token (`bun run check`);
//   · a backticked path to a program followed by more
//     (`.bounded/harness/scripts/bounded sync-config`);
//   · a backticked single word that is one of the harness's own command
//     names (`sync-config`, `green_gate`, `red-gate`);
//   · unbackticked text that starts a shell escape (`! bun …`), names a
//     common command-line tool followed by a lowercase word (`git pull`), or
//     a path to a program followed by more.
//
// A command that starts with one of the harness's reserved recovery commands
// is allowed: those are the user's by design, and the harness says why.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { gates } from "../../packs/ts/gates.ts";
import { LEAD_COMMANDS } from "../../src/lead-commands.ts";
import { GATE_TOOLS } from "../../src/path-policy.ts";

/** The reserved recovery commands, as the drift test spells them. It must
 *  equal the core's `USER_RECOVERY_COMMANDS`. */
export const RESERVED: readonly string[] = ["bounded lead release", "gh auth login"];

/** The harness's own command names that are one word: a lead command, a
 *  gate, or a gate tool, when the name cannot be an ordinary word. */
export const HARNESS_WORDS: ReadonlySet<string> = new Set(
  [...LEAD_COMMANDS.map((c) => c.name), ...gates.map((g) => g.name), ...GATE_TOOLS].filter((name) => /^[a-z]+(?:[-_][a-z]+)+$/.test(name)),
);

export interface Violation {
  readonly where: string;
  readonly sentence: string;
  readonly command: string;
}

const ADDRESSES_USER = /\buser\b/i;
const TOOL = /(^|[\s("'])(!\s?[a-z]|(bounded|bash|bun|bunx|npm|npx|git|gh|docker)\s+[a-z:-]+|(?:\.{1,2}\/|\/|\.bounded\/)(?:[\w.-]+\/)*[\w-]+\s+[a-z][a-z:-]*)/;
/** A path to a program, then more: `.bounded/harness/scripts/bounded sync-config`. */
const PATH_COMMAND = /^(?:\.{1,2}\/|\/|\.bounded\/)(?:[\w.-]+\/)*[\w-]+\s+\S/;
const POINTS_BACK = /\b(they|them|their)\b/i;

/** Prose split into sentences: paragraph and list-item breaks, table rows,
 *  headings, code fences, and sentence ends before a capital, a backtick or
 *  an opening bracket. */
export function sentences(text: string): string[] {
  const blocks: string[] = [];
  let fence: string[] | undefined;
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join(" "));
    current = [];
  };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (fence === undefined) {
        flush();
        fence = [];
      } else {
        blocks.push(fence.join("\n"));
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) {
      fence.push(line);
      continue;
    }
    if (line.trim() === "" || /^\s*#/.test(line) || /^\s*\|/.test(line)) {
      flush();
      if (line.trim() !== "") blocks.push(line.trim());
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) flush();
    current.push(line.trim());
  }
  flush();
  if (fence !== undefined) blocks.push(fence.join("\n"));
  return blocks.flatMap((block) => block.split(/(?<=[.!?])\s+(?=[A-Z`(["*])/)).map((s) => s.trim()).filter((s) => s !== "");
}

const reserved = (command: string): boolean => RESERVED.some((entry) => command === entry || command.startsWith(`${entry} `));

/** The commands a sentence addressing the user names (reserved ones
 *  excepted). `addressed` overrides whether it addresses the user. */
export function commandsIn(sentence: string, addressed = ADDRESSES_USER.test(sentence)): string[] {
  if (!addressed) return [];
  const out: string[] = [];
  for (const match of sentence.matchAll(/`([^`]+)`/g)) {
    const span = match[1]!.trim();
    // A first token ending in a colon is a label (`declined: true`), not a command.
    if (span.startsWith("!") || /^[a-z][a-z0-9_.-]*(?::[a-z0-9_.-]+)*\s+\S/.test(span) || PATH_COMMAND.test(span) || HARNESS_WORDS.has(span)) {
      if (!reserved(span)) out.push(span);
    }
  }
  const bare = sentence.replace(/`[^`]*`/g, " ");
  const pattern = new RegExp(TOOL.source, "g");
  for (const match of bare.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[1]!.length;
    const command = bare.slice(start).split(/[.;,)]\s|[.;,)]$|\s—\s/)[0]!.trim();
    if (!reserved(command)) out.push(command);
  }
  return out;
}

/** Every command named to the user in `text`, sentence by sentence. With
 *  `strict` (an output routed to the user: `route → user`), every sentence
 *  addresses the user. */
export function userCommandViolations(
  where: string, text: string, exempt: (sentence: string) => boolean = () => false, strict = false,
): Violation[] {
  const out: Violation[] = [];
  let previous = false;
  for (const sentence of sentences(text)) {
    const addressed = strict || ADDRESSES_USER.test(sentence) || (previous && POINTS_BACK.test(sentence));
    previous = ADDRESSES_USER.test(sentence) || strict;
    if (exempt(sentence)) continue;
    for (const command of commandsIn(sentence, addressed)) out.push({ where, sentence, command });
  }
  return out;
}

/** Markdown with one section (by its exact heading line) removed. */
export function withoutSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => line.trim() === heading);
  if (at < 0) return markdown;
  const level = /^#+/.exec(heading)![0].length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]!);
    if (m !== null && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, at), ...lines.slice(end)].join("\n");
}

/** The text of one section, by its exact heading line ("" when absent). */
export function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => line.trim() === heading);
  if (at < 0) return "";
  const level = /^#+/.exec(heading)![0].length;
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]!);
    if (m !== null && m[1]!.length <= level) break;
    out.push(lines[i]!);
  }
  return out.join("\n");
}

// --- source strings ------------------------------------------------------------

/** Every file under `dir` matching `keep`, recursively, skipping dependency
 *  and test-data directories. */
export function filesUnder(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      if (name === "node_modules" || name === "testdata" || name === "reference" || name === "dist" || name.startsWith(".")) continue;
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (keep(full)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Non-test TypeScript source. */
export const isSource = (path: string): boolean =>
  /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !/\.test-support\.ts$/.test(path) && !/\.d\.ts$/.test(path);

/** Top-level `const NAME = "text"` declarations, by name, across files: a
 *  name declared with two different texts is dropped as ambiguous. */
export function constantStrings(files: readonly { path: string; source: string }[]): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const { path, source } of files) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        const init = declaration.initializer;
        if (!ts.isStringLiteral(init) && !ts.isNoSubstitutionTemplateLiteral(init)) continue;
        const name = declaration.name.text;
        const prior = seen.get(name);
        seen.set(name, prior === undefined || prior === init.text ? init.text : null);
      }
    }
  }
  return new Map([...seen].filter((entry): entry is [string, string] => entry[1] !== null));
}

/**
 * The string texts a source file holds, read through the TypeScript AST:
 * string literals, no-substitution templates, and templates (head, middles
 * and tails, with each substitution read as the constant it names, else
 * "…"). A `+` chain is read whole, so a sentence split across literals is one
 * text. Comments are never read.
 */
export function stringTexts(path: string, source: string, constants: ReadonlyMap<string, string> = new Map()): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const isPlus = (node: ts.Node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
  const textOf = (node: ts.Node): string | undefined => {
    if (ts.isParenthesizedExpression(node)) return textOf(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans.map((span) => (textOf(span.expression) ?? "…") + span.literal.text).join("");
    }
    if (ts.isIdentifier(node)) return constants.get(node.text);
    if (isPlus(node)) {
      const left = textOf(node.left);
      const right = textOf(node.right);
      return left === undefined && right === undefined ? undefined : `${left ?? "…"}${right ?? "…"}`;
    }
    return undefined;
  };
  const hasLiteral = (node: ts.Node): boolean =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) ||
    (ts.isParenthesizedExpression(node) && hasLiteral(node.expression)) || (isPlus(node) && (hasLiteral(node.left) || hasLiteral(node.right)));
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (isPlus(node) && hasLiteral(node)) {
      const text = textOf(node);
      if (text !== undefined) out.push(text);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = textOf(node);
      if (text !== undefined) out.push(text);
      if (ts.isTemplateExpression(node)) for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The scanned source of the harness, project-relative, with its texts. */
export function harnessSources(agentRoot: string): { path: string; source: string }[] {
  const roots = [join(agentRoot, "src"), join(agentRoot, "hosts"), join(agentRoot, "trackers")];
  const packs = join(agentRoot, "packs");
  for (const pack of readdirSync(packs).sort()) {
    const scripts = join(packs, pack, "scripts");
    try {
      if (statSync(scripts).isDirectory()) roots.push(scripts);
    } catch {
      // a pack without scripts
    }
  }
  return roots.flatMap((root) => filesUnder(root, isSource))
    .map((path) => ({ path: relative(agentRoot, path), source: readFileSync(path, "utf8") }));
}
