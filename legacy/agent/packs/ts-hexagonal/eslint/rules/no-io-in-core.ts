// Domain and application code does no I/O (docs/architecture/
// layers-and-dependencies.md; ADR LEG-2026-062). It is also the defence ADR
// LEG-2026-062 names against a builder whose implementation reads a test file at
// run time and smuggles it out through an error message: code that cannot
// open a file, spawn a process, open a socket or read the environment cannot
// do that. `layer-dependency` already refuses every library but zod here; this
// rule names the I/O routes explicitly, including the runtime globals no
// import is needed for, and says why.
//
// Refused in a non-test file under domain/ or application/:
//   - loading a filesystem, process, network or Bun module (`node:fs`, `fs`,
//     `fs/promises`, `node:child_process`, `node:net`, `bun`, `bun:*`, …) in
//     any import form that loads it at run time;
//   - `Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.spawnSync` and `process.env`,
//     directly or through `globalThis` / `global` / `self` / `window`;
//   - any other use of `Bun`, `process` or a global object the rule cannot
//     see through (aliasing, destructuring, a computed key, passing it on),
//     fail closed.
//
// The shipped architecture.test.ts checks the same thing the same way, by
// name rather than by scope, so the two never disagree.

import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import { hexFile, importVisitors } from "../hexagonal.ts";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** Module names (with or without `node:`, and their subpaths) that do I/O. */
const IO_MODULES = ["fs", "child_process", "net"] as const;
/** The runtime globals, and the members of each that reach I/O. */
const IO_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  Bun: ["file", "write", "spawn", "spawnSync"],
  process: ["env"],
};
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "self", "window"]);

/** Does this module specifier load one of the I/O modules? */
export function isIoModule(spec: string): boolean {
  if (spec === "bun" || spec.startsWith("bun:") || spec.startsWith("bun/")) return true;
  const bare = spec.startsWith("node:") ? spec.slice("node:".length) : spec;
  return IO_MODULES.some((name) => bare === name || bare.startsWith(`${name}/`));
}

type Parent = TSESTree.Node | undefined;

/** A static member name read off `node` by its parent, or undefined. */
function memberName(node: TSESTree.Node, parent: Parent): string | undefined | null {
  if (parent?.type !== "MemberExpression" || parent.object !== node) return null;
  if (!parent.computed && parent.property.type === "Identifier") return parent.property.name;
  if (parent.computed && parent.property.type === "Literal" && typeof parent.property.value === "string") return parent.property.value;
  if (parent.computed && parent.property.type === "TemplateLiteral" && parent.property.expressions.length === 0) {
    return parent.property.quasis[0]!.value.cooked ?? undefined;
  }
  return undefined;
}

/** Is this identifier a name position (a property or member name), not a reference? */
function isNamePosition(node: TSESTree.Identifier, parent: Parent): boolean {
  if (parent === undefined) return false;
  switch (parent.type) {
    case "MemberExpression":
      return parent.property === node && !parent.computed;
    case "Property":
      return parent.key === node && !parent.computed && !parent.shorthand;
    case "PropertyDefinition":
    case "MethodDefinition":
    case "TSPropertySignature":
    case "TSMethodSignature":
    case "TSAbstractPropertyDefinition":
    case "TSAbstractMethodDefinition":
      return parent.key === node && !parent.computed;
    case "TSQualifiedName":
      return parent.right === node;
    case "TSEnumMember":
      return parent.id === node;
    default:
      return false;
  }
}

export const noIoInCore = createRule<[], "module" | "member" | "unchecked">({
  name: "no-io-in-core",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      module: "'{{spec}}' does I/O; {{layer}} code holds no I/O. Declare an out port and implement it in an out adapter " +
        "(docs/architecture/layers-and-dependencies.md).",
      member: "'{{name}}' does I/O; {{layer}} code holds no I/O. Take what it reads through an out port or the command " +
        "instead (docs/architecture/layers-and-dependencies.md).",
      unchecked: "'{{name}}' is used in a way this check cannot see through; {{layer}} code reads no runtime global. " +
        "Take what it needs through an out port or the command instead (docs/architecture/layers-and-dependencies.md).",
    },
  },
  defaultOptions: [],
  create(context) {
    const file = hexFile(context.filename, context.cwd);
    if (file === undefined || file.testSide || file.location.workspace !== "context") return {};
    const layer = file.location.layer;
    if (layer !== "domain" && layer !== "application") return {};
    const reported = new Set<string>();
    const report = (node: TSESTree.Node, messageId: "member" | "unchecked", name: string): void => {
      const key = `${node.range[0]}:${node.range[1]}`;
      if (reported.has(key)) return;
      reported.add(key);
      context.report({ node, messageId, data: { name, layer } });
    };

    /** Judge one reference to a runtime global: `node` is the expression that names it. */
    const judge = (global: string, node: TSESTree.Node): void => {
      const member = memberName(node, node.parent);
      if (member === null || member === undefined) {
        report(node, "unchecked", global);
      } else if (IO_MEMBERS[global]!.includes(member)) {
        report(node.parent!, "member", `${global}.${member}`);
      }
    };

    return {
      ...importVisitors((use) => {
        if (use.spec === undefined || use.typeOnly || use.form === "member" || !isIoModule(use.spec)) return;
        context.report({ node: use.node, messageId: "module", data: { spec: use.spec, layer } });
      }),
      Identifier(node): void {
        const parent = node.parent;
        if (isNamePosition(node, parent)) return;
        if (Object.hasOwn(IO_MEMBERS, node.name)) {
          judge(node.name, node);
          return;
        }
        if (!GLOBAL_OBJECTS.has(node.name)) return;
        // `globalThis.Bun.file` / `globalThis["process"].env`: the member access names the global.
        const member = memberName(node, parent);
        if (member === null || member === undefined) {
          report(node, "unchecked", node.name);
        } else if (Object.hasOwn(IO_MEMBERS, member)) {
          judge(member, parent!);
        }
      },
    };
  },
});
