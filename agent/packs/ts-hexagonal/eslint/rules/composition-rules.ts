// The two rules that keep wiring in one place (docs/architecture/
// apps-and-composition.md): only a composition root constructs handlers and
// adapters, and an entry file only hosts what the composition root returns.

import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import { type HexRuleOptions, hexFile, importVisitors, OPTIONS_SCHEMA, resolveUse, type Target, wiringTarget, workspaceIndex } from "../hexagonal.ts";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

const isCompositionRoot = (path: string): boolean => path.endsWith("/composition-root.ts");

/** Is this import target a class only the composition root may construct? */
function constructedKind(target: Target, imported: string): "handler" | "adapter" | undefined {
  if (target.kind === "workspace" && target.workspace.kind === "context") {
    if (target.subpath === "application" && /Handler$/.test(imported)) return "handler";
    if (target.subpath.startsWith("adapters/")) return "adapter";
  }
  if (target.kind === "file") {
    if (/\.handler(\.[cm]?[jt]s)?$/.test(target.path)) return "handler";
    const location = target.location;
    if (location?.workspace === "context" && (location.layer === "adapters-in" || location.layer === "adapters-out")) return "adapter";
  }
  return undefined;
}

export const compositionRootOnlyConstructs = createRule<[HexRuleOptions?], "construct" | "factory" | "namespace" | "loader">({
  name: "composition-root-only-constructs",
  meta: {
    type: "problem",
    schema: OPTIONS_SCHEMA,
    messages: {
      construct: "'new {{name}}' constructs a {{kind}}; only an app's composition-root.ts chooses and constructs handlers " +
        "and adapters. Take it as a constructor parameter or a port instead (docs/architecture/apps-and-composition.md).",
      namespace: "'{{spec}}' is imported whole as a namespace, so what is constructed from it cannot be checked; import " +
        "application and adapter code by name outside composition-root.ts (docs/architecture/apps-and-composition.md).",
      loader: "'{{spec}}' is loaded at runtime; only an app's composition-root.ts chooses application and adapter code, " +
        "and it imports it statically (docs/architecture/apps-and-composition.md).",
      factory: "'{{name}}(…)' builds an in adapter; only an app's composition-root.ts does that. An entry file hosts what " +
        "the composition root returns (docs/architecture/apps-and-composition.md).",
    },
  },
  defaultOptions: [{}],
  create(context) {
    const file = hexFile(context.filename, context.cwd);
    if (file === undefined || file.testSide || isCompositionRoot(file.path)) return {};
    // Files inside an adapter technology build their own parts (a router its
    // procedures): that is the adapter's inside, not wiring.
    const location = file.location;
    const insideAdapter = location.workspace === "context" && (location.layer === "adapters-in" || location.layer === "adapters-out");
    const index = workspaceIndex(file.root, context.options[0]?.workspaces);
    const locals = new Map<string, { target: Target; imported: string }>();
    const namespaces = new Map<string, "application" | "adapters">();
    const visitors = importVisitors((use) => {
      if (use.spec === undefined || use.member || use.typeOnly) return;
      const reaches = wiringTarget(file, use.spec, index);
      if (use.form === "loader" && reaches !== undefined) {
        context.report({ node: use.node, messageId: "loader", data: { spec: use.spec } });
        return;
      }
      if (use.node.type !== "ImportDeclaration") return;
      const target = resolveUse(file, use.spec, index);
      if (use.form === "namespace" && reaches !== undefined && !(insideAdapter && target.kind === "file")) {
        const specifier = use.node.specifiers.find((s) => s.type === "ImportNamespaceSpecifier")!;
        namespaces.set(specifier.local.name, reaches);
        context.report({ node: use.node, messageId: "namespace", data: { spec: use.spec } });
      }
      for (const specifier of (use.node as TSESTree.ImportDeclaration).specifiers) {
        if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
        const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value);
        locals.set(specifier.local.name, { target, imported });
      }
    });
    const loaders = visitors.CallExpression as (node: TSESTree.CallExpression) => void;
    return {
      ImportDeclaration: visitors.ImportDeclaration!,
      ImportExpression: visitors.ImportExpression!,
      TSImportEqualsDeclaration: visitors.TSImportEqualsDeclaration!,
      NewExpression(node): void {
        const callee = node.callee;
        if (callee.type === "MemberExpression" && callee.object.type === "Identifier" && namespaces.has(callee.object.name)) {
          const name = context.sourceCode.getText(callee);
          const kind = namespaces.get(callee.object.name) === "adapters" ? "adapter" : "handler";
          context.report({ node, messageId: "construct", data: { name, kind } });
          return;
        }
        if (node.callee.type !== "Identifier") return;
        const source = locals.get(node.callee.name);
        const kind = source === undefined ? undefined : constructedKind(source.target, source.imported);
        if (kind === undefined || (insideAdapter && kind === "adapter" && source!.target.kind === "file")) return;
        context.report({ node, messageId: "construct", data: { name: node.callee.name, kind } });
      },
      CallExpression(node): void {
        loaders(node);
        if (node.callee.type !== "Identifier" || location.workspace !== "app") return;
        const source = locals.get(node.callee.name);
        if (source?.target.kind === "workspace" && source.target.workspace.kind === "context" &&
            source.target.subpath.startsWith("adapters/")) {
          context.report({ node, messageId: "factory", data: { name: node.callee.name } });
        }
      },
    };
  },
});

export const entryHostsOnly = createRule<[HexRuleOptions?], "value">({
  name: "entry-hosts-only",
  meta: {
    type: "problem",
    schema: OPTIONS_SCHEMA,
    messages: {
      value: "'{{spec}}' is imported as a value outside composition-root.ts. An entry file only hosts what the " +
        "composition root returns: import that from ./composition-root.ts, and anything from a context as a type " +
        "only (docs/architecture/apps-and-composition.md).",
    },
  },
  defaultOptions: [{}],
  create(context) {
    const file = hexFile(context.filename, context.cwd);
    const location = file?.location;
    if (file === undefined || location?.workspace !== "app" || location.browser || file.testSide || isCompositionRoot(file.path)) {
      return {};
    }
    const index = workspaceIndex(file.root, context.options[0]?.workspaces);
    return importVisitors((use) => {
      if (use.spec === undefined || use.member || use.typeOnly) return;
      const target = resolveUse(file, use.spec, index);
      if (target.kind === "workspace" && target.workspace.kind === "context") {
        context.report({ node: use.node, messageId: "value", data: { spec: use.spec } });
      }
    });
  },
});
