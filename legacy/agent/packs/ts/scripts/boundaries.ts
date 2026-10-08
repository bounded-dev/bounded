// The value-object boundaries obligation (TN-26-001 Run 7; ADR LEG-2026-059 form).
//
// A value object's `parse` is the only door in from raw input. The generated
// laws cover what is true of EVERY value object: parse refuses `null`, `[]`,
// `42`, a `Date`. They cannot cover an input of the RIGHT base type and the
// wrong value: `"usd"` is a string, and only someone thinking about
// currencies knows it must fail. So the hand-written suite must contain, per
// value object and identifier, a block
//
//   describe("<Name> — boundaries", () => { … })      (em dash, U+2014)
//
// with at least one ACCEPTED literal and at least TWO DISTINCT REJECTED
// literals of the value object's own base type, asserted on the `Result`
// that `parse` returns (ADR LEG-2026-059):
//
//   accepted   expect(Name.parse(<lit>).ok).toBe(true)
//              expect(Name.parse(<lit>)).toEqual({ ok: true, … })     (also toStrictEqual, toMatchObject)
//   rejected   expect(Name.parse(<lit>).ok).toBe(false)
//              expect(Name.parse(<lit>)).toEqual({ ok: false, … })    (also toStrictEqual, toMatchObject)
//
// The parse may be bound to a `const` first (`const r = Name.parse("x");
// expect(r.ok).toBe(false)`); bindings are resolved lexically, so two tests
// each binding `r` are two assertions. Wrong-type rejections do not count:
// the laws own them. Nothing looser counts either: `toBeTruthy`, a negated
// matcher or a non-literal argument proves nothing about a boundary.
//
// TWO IS A FLOOR, NOT A TARGET. It eliminates OMISSION (Run 7: nine parsers,
// zero assertions); it does not eliminate evasion. Be honest about that.

import { type CallExpression, Node, Project, type SourceFile, SyntaxKind } from "ts-morph";
import type { ObligationGap, ObligationInput, ObligationSource, TestObligation } from "../pack.ts";
import { isDomainConceptPath, parseDomainConcept, valueTypeOf } from "./domain-concept.ts";

/** U+2014. Spelled out because the whole check turns on it not being a hyphen. */
export const BOUNDARY_DASH = "—";

/** The floor, not the target. */
export const MIN_REJECTIONS = 2;

export type BoundaryBase = "string" | "number" | "boolean";

/** The exact describe name a value object's boundaries block must carry. */
export function boundaryDescribeName(name: string): string {
  return `${name} ${BOUNDARY_DASH} boundaries`;
}

export interface BoundaryTarget {
  readonly name: string;
  readonly base: BoundaryBase;
  readonly contractFile: string;
}

export type BoundaryViolationKind = "missing-block" | "misnamed-block" | "skipped-block" | "no-accepted-parse" | "too-few-rejections";

export interface BoundaryViolation {
  readonly name: string;
  readonly contractFile: string;
  readonly kind: BoundaryViolationKind;
  readonly base: BoundaryBase;
  /** Near-miss or skipped describe titles found for this name. */
  readonly found: readonly string[];
  readonly accepted: number;
  /** Distinct base-typed rejected literals, as written. */
  readonly rejections: readonly string[];
  /** Rejected inputs that do not count: wrong base type. */
  readonly wrongTypeRejections: readonly string[];
}

// --- reading literals and parse calls ---------------------------------------------

interface LiteralArg {
  readonly kind: BoundaryBase | "other";
  readonly text: string;
  /** Undefined when the argument is not a literal at all. */
  readonly key: string | undefined;
}

const MAX_BINDING_DEPTH = 4;

/** The initializer of the nearest lexical binding of an identifier. */
function initializerOf(identifier: Node): Node | undefined {
  const name = identifier.getText();
  let node: Node | undefined = identifier;
  while (node !== undefined) {
    const parent: Node | undefined = node.getParent();
    if (parent !== undefined && (Node.isBlock(parent) || Node.isSourceFile(parent))) {
      for (const stmt of parent.getStatements()) {
        if (!Node.isVariableStatement(stmt)) continue;
        for (const decl of stmt.getDeclarationList().getDeclarations()) {
          const declName = decl.getNameNode();
          if (Node.isIdentifier(declName) && declName.getText() === name) return decl.getInitializer();
        }
      }
    }
    node = parent;
  }
  return undefined;
}

function literalArg(node: Node | undefined, depth = 0): LiteralArg {
  if (node === undefined) return { kind: "other", text: "", key: undefined };
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: "string", text: node.getText(), key: `s:${node.getLiteralValue()}` };
  }
  if (Node.isNumericLiteral(node)) return { kind: "number", text: node.getText(), key: `n:${node.getLiteralValue()}` };
  if (Node.isPrefixUnaryExpression(node)) {
    const operand = node.getOperand();
    if (Node.isNumericLiteral(operand)) {
      const sign = node.getOperatorToken() === SyntaxKind.MinusToken ? -1 : 1;
      return { kind: "number", text: node.getText(), key: `n:${sign * operand.getLiteralValue()}` };
    }
  }
  if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) return { kind: "boolean", text: node.getText(), key: `b:${node.getText()}` };
  if (Node.isIdentifier(node) && depth < MAX_BINDING_DEPTH) {
    const bound = initializerOf(node);
    if (bound !== undefined) return literalArg(bound, depth + 1);
  }
  return { kind: "other", text: node.getText(), key: undefined };
}

/** A `<Name>.parse(<arg>)` call, directly or through a `const`. */
function parseCallOf(node: Node | undefined, depth = 0): { name: string; arg: LiteralArg } | undefined {
  if (node === undefined) return undefined;
  if (Node.isIdentifier(node)) return depth < MAX_BINDING_DEPTH ? parseCallOf(initializerOf(node), depth + 1) : undefined;
  if (Node.isAwaitExpression(node) || Node.isParenthesizedExpression(node)) return parseCallOf(node.getExpression(), depth + 1);
  if (!Node.isCallExpression(node)) return undefined;
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "parse") return undefined;
  const receiver = callee.getExpression();
  if (!Node.isIdentifier(receiver)) return undefined;
  return { name: receiver.getText(), arg: literalArg(node.getArguments()[0]) };
}

/** What an `expect(<subject>)` asserts about a parse result: `true` for an
 *  acceptance, `false` for a rejection, undefined for anything else. */
function assertedOk(expectCall: CallExpression): boolean | undefined {
  const subject = expectCall.getArguments()[0];
  const onOk = subject !== undefined && Node.isPropertyAccessExpression(subject) && subject.getName() === "ok";
  const access = expectCall.getParent();
  if (access === undefined || !Node.isPropertyAccessExpression(access) || access.getExpression() !== expectCall) return undefined;
  const call = access.getParent();
  if (call === undefined || !Node.isCallExpression(call) || call.getExpression() !== access) return undefined;
  const matcher = access.getName();
  const arg = call.getArguments()[0];
  if (onOk && matcher === "toBe" && arg !== undefined) {
    if (Node.isTrueLiteral(arg)) return true;
    if (Node.isFalseLiteral(arg)) return false;
    return undefined;
  }
  if (!onOk && (matcher === "toEqual" || matcher === "toStrictEqual" || matcher === "toMatchObject") &&
      arg !== undefined && Node.isObjectLiteralExpression(arg)) {
    const ok = arg.getProperty("ok");
    if (ok === undefined || !Node.isPropertyAssignment(ok)) return undefined;
    const value = ok.getInitializer();
    if (value !== undefined && Node.isAsExpression(value)) {
      const inner = value.getExpression();
      return Node.isTrueLiteral(inner) ? true : Node.isFalseLiteral(inner) ? false : undefined;
    }
    return value !== undefined && Node.isTrueLiteral(value) ? true : value !== undefined && Node.isFalseLiteral(value) ? false : undefined;
  }
  return undefined;
}

/** The parse call an `expect(...)` subject is about: `X.parse(l)`, `X.parse(l).ok`, or a binding of either. */
function subjectParse(expectCall: CallExpression): { name: string; arg: LiteralArg } | undefined {
  const subject = expectCall.getArguments()[0];
  if (subject === undefined) return undefined;
  if (Node.isPropertyAccessExpression(subject) && subject.getName() === "ok") return parseCallOf(subject.getExpression());
  return parseCallOf(subject);
}

// --- blocks ----------------------------------------------------------------------

interface DescribeBlock {
  readonly title: string;
  readonly body: Node | undefined;
  readonly skipped: boolean;
}

function describeBlocks(sf: SourceFile): DescribeBlock[] {
  const blocks: DescribeBlock[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    let skipped = false;
    let isDescribe = false;
    if (Node.isIdentifier(callee)) {
      isDescribe = callee.getText() === "describe";
    } else if (Node.isPropertyAccessExpression(callee) && Node.isIdentifier(callee.getExpression()) && callee.getExpression().getText() === "describe") {
      const modifier = callee.getName();
      isDescribe = ["only", "skip", "todo", "if", "skipIf", "concurrent", "serial"].includes(modifier);
      skipped = modifier === "skip" || modifier === "todo" || modifier === "skipIf" || modifier === "if";
    }
    if (!isDescribe) continue;
    const [titleNode, bodyNode] = call.getArguments();
    if (titleNode === undefined || !(Node.isStringLiteral(titleNode) || Node.isNoSubstitutionTemplateLiteral(titleNode))) continue;
    const body = bodyNode !== undefined && (Node.isArrowFunction(bodyNode) || Node.isFunctionExpression(bodyNode)) ? bodyNode.getBody() : undefined;
    blocks.push({ title: titleNode.getLiteralValue(), body, skipped });
  }
  return blocks;
}

/** Case, spacing and dash-flavour insensitive: the shape of a near miss. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[-‐-―−]+/g, "-").replace(/\s+/g, " ").replace(/\s*-\s*/g, "-").trim();
}

/** Tests inside a block that are skipped or todo do not count. */
function insideSkippedTest(node: Node, body: Node): boolean {
  let current: Node | undefined = node.getParent();
  while (current !== undefined && current !== body) {
    if (Node.isCallExpression(current)) {
      const callee = current.getExpression();
      if (Node.isPropertyAccessExpression(callee) && Node.isIdentifier(callee.getExpression()) &&
          ["test", "it"].includes(callee.getExpression().getText()) && ["skip", "todo", "skipIf", "if"].includes(callee.getName())) return true;
    }
    current = current.getParent();
  }
  return false;
}

/** Check each target's boundaries block against the hand-written tests. Pure. */
export function checkBoundaries(targets: readonly BoundaryTarget[], tests: readonly ObligationSource[]): BoundaryViolation[] {
  if (targets.length === 0) return [];
  const evidence = new Map(targets.map((t) => [t.name, {
    exact: false, skippedExact: false, found: [] as string[], accepted: 0, rejections: new Map<string, string>(), wrongType: [] as string[],
  }]));
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  for (const { path, source } of tests) {
    const sf = project.createSourceFile(`/b/${path.replace(/[^\w.-]+/g, "_")}${path.endsWith(".tsx") ? "" : ".ts"}`, source, { overwrite: true });
    for (const block of describeBlocks(sf)) {
      for (const target of targets) {
        const e = evidence.get(target.name)!;
        const expected = boundaryDescribeName(target.name);
        if (block.title !== expected) {
          if (normalizeTitle(block.title) === normalizeTitle(expected)) e.found.push(block.title);
          continue;
        }
        if (block.skipped) {
          e.skippedExact = true;
          e.found.push(block.title);
          continue;
        }
        e.exact = true;
        if (block.body === undefined) continue;
        for (const call of block.body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const callee = call.getExpression();
          if (!Node.isIdentifier(callee) || callee.getText() !== "expect" || insideSkippedTest(call, block.body)) continue;
          const parse = subjectParse(call);
          if (parse === undefined || parse.name !== target.name || parse.arg.key === undefined) continue;
          const ok = assertedOk(call);
          if (ok === true) e.accepted += 1;
          else if (ok === false) {
            if (parse.arg.kind === target.base) e.rejections.set(parse.arg.key, parse.arg.text);
            else e.wrongType.push(parse.arg.text);
          }
        }
      }
    }
  }
  const out: BoundaryViolation[] = [];
  for (const target of targets) {
    const e = evidence.get(target.name)!;
    const common = {
      name: target.name, contractFile: target.contractFile, base: target.base, found: [...new Set(e.found)],
      accepted: e.accepted, rejections: [...e.rejections.values()], wrongTypeRejections: e.wrongType,
    };
    if (!e.exact) {
      out.push({ ...common, kind: e.skippedExact ? "skipped-block" : common.found.length > 0 ? "misnamed-block" : "missing-block" });
      continue;
    }
    if (e.accepted === 0) out.push({ ...common, kind: "no-accepted-parse" });
    if (e.rejections.size < MIN_REJECTIONS) out.push({ ...common, kind: "too-few-rejections" });
  }
  return out;
}

/** The message for one violation, with the block to write. */
export function boundaryMessage(v: BoundaryViolation): string {
  const expected = boundaryDescribeName(v.name);
  const sin: Record<BoundaryViolationKind, string> = {
    "missing-block": `${v.name} has no "${expected}" block: nothing says which ${v.base} values it accepts and which it refuses`,
    "misnamed-block": `${v.name}'s boundaries block is misnamed (${v.found.join(", ")}); the title is exactly "${expected}", with an em dash (U+2014)`,
    "skipped-block": `${v.name}'s boundaries block is skipped; a skipped obligation is an undischarged one`,
    "no-accepted-parse": `${v.name}'s boundaries block never asserts a valid literal parses: expect(${v.name}.parse(<valid>).ok).toBe(true)`,
    "too-few-rejections": `${v.name}'s boundaries block has ${v.rejections.length} distinct ${v.base} rejection${v.rejections.length === 1 ? "" : "s"} and needs ${MIN_REJECTIONS}: ` +
      `expect(${v.name}.parse(<invalid ${v.base}>).ok).toBe(false), one per axis of the rule` +
      (v.wrongTypeRejections.length > 0 ? ` (not counted, the laws own wrong types: ${v.wrongTypeRejections.join(", ")})` : ""),
  };
  return sin[v.kind];
}

/** Every value object and identifier of the design, with its base type. */
export function boundaryTargets(input: ObligationInput): BoundaryTarget[] {
  const out: BoundaryTarget[] = [];
  for (const workspace of input.facts.workspaces) {
    for (const contract of workspace.contracts) {
      if (!isDomainConceptPath(contract.path)) continue;
      const model = parseDomainConcept(contract.path, contract.source);
      if (model.kind === "entity") continue;
      out.push({ name: model.name, base: valueTypeOf(model), contractFile: contract.path });
    }
  }
  return out;
}

/** The ts pack's boundaries obligation, prepended by the gates like the domain one. */
export const boundariesObligation: TestObligation = {
  name: "value-object-boundaries",
  description: "Every value object and identifier has a \"<Name> — boundaries\" block with an accepted literal and two distinct rejected literals of its base type.",
  check(input: ObligationInput): ObligationGap[] {
    return checkBoundaries(boundaryTargets(input), input.tests).map((v) => ({
      level: "boundaries",
      path: v.contractFile.replace(/\.contract\.ts$/, ".test.ts"),
      message: boundaryMessage(v),
    }));
  },
};
