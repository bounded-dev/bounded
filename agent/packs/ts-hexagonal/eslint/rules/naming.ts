// The naming table of TN-26-012 §2: areas are plural business nouns, features
// verb first, and the classes in handler and out-adapter files carry exactly
// the names the generators, the composition root and the tests derive.

import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import { adapterClassPrefix, pascalCase } from "../../../ts/scripts/naming.ts";
import { featureNameProblem, type HexLocation, isAreaName, KEBAB } from "../../scripts/grammar.ts";
import { hexFile } from "../hexagonal.ts";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** Folders named by the layout itself, not by the business. */
const LAYOUT_FOLDERS = new Set(["shared", "schema", "migrations"]);

/** The area and feature folders of a path, where it has them. */
function slices(location: HexLocation): { area?: string; feature?: string } {
  if (location.workspace !== "context") return {};
  const inner = location.inner;
  if (location.layer === "domain" && inner.length === 3) return { area: inner[1] };
  if (location.layer === "application" && inner.length === 4) return { area: inner[1], feature: inner[2] };
  if ((location.layer === "adapters-in" || location.layer === "adapters-out") && inner.length === 5) {
    const role = inner[4]!.split(".");
    const feature = role.length === 3 && role[1] !== "mapper" && role[0] !== inner[3] ? role[0] : undefined;
    return { area: inner[3], ...(feature === undefined ? {} : { feature }) };
  }
  return {};
}

/** Why a path's area or feature name breaks the table, or undefined. */
export function pathNamingProblem(location: HexLocation): string | undefined {
  const { area, feature } = slices(location);
  if (area !== undefined && !LAYOUT_FOLDERS.has(area) && !isAreaName(area)) {
    return `area '${area}' must be a kebab-case plural business noun (e.g. 'notes', 'order-lines')`;
  }
  if (feature !== undefined && area !== undefined && !LAYOUT_FOLDERS.has(area)) {
    const problem = featureNameProblem(area, feature);
    if (problem !== undefined) return `feature ${problem}`;
  }
  return undefined;
}

/** The exact class name a file must export, or a prefix/suffix pair. */
function expectedClass(location: HexLocation): { exact?: string; prefix?: string; suffix?: string } | undefined {
  if (location.workspace !== "context") return undefined;
  const inner = location.inner;
  const name = inner.at(-1)!;
  if (/\.(test|test-support|laws\.test)\.tsx?$/.test(name)) return undefined;
  if (location.layer === "application" && inner.length === 4 && name === `${inner[2]}.handler.ts` && KEBAB.test(inner[2]!)) {
    return { exact: `${pascalCase(inner[2]!)}Handler` };
  }
  if (location.layer === "adapters-out" && location.tech !== undefined && KEBAB.test(location.tech)) {
    const prefix = adapterClassPrefix(location.tech);
    if (inner.length === 4 && name === `${location.tech}-database.ts`) return { exact: `${prefix}Database` };
    const parts = name.split(".");
    if (inner.length === 5 && parts.length === 3 && parts[1] !== "mapper" && KEBAB.test(parts[0]!)) {
      if (parts[1] === "store") return { exact: `${prefix}${pascalCase(parts[0]!)}Store` };
      return { prefix, suffix: pascalCase(parts[1]!) };
    }
  }
  return undefined;
}

export const naming = createRule<[], "path" | "className">({
  name: "naming",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      path: "'{{path}}': {{detail}} (docs/architecture/directory-structure.md, Naming)",
      className: "Class '{{actual}}' in '{{path}}' must be named {{expected}}: the composition root, the tests and the " +
        "generators all derive that name (docs/architecture/directory-structure.md, Naming)",
    },
  },
  defaultOptions: [],
  create(context) {
    const file = hexFile(context.filename, context.cwd);
    if (file === undefined) return {};
    const expected = expectedClass(file.location);
    const checkClass = (id: TSESTree.Identifier | null): void => {
      if (id === null || expected === undefined) return;
      const ok = expected.exact !== undefined
        ? id.name === expected.exact
        : id.name.startsWith(expected.prefix!) && id.name.endsWith(expected.suffix!) &&
          id.name.length > expected.prefix!.length + expected.suffix!.length;
      if (!ok) {
        context.report({
          node: id,
          messageId: "className",
          data: {
            actual: id.name,
            path: file.path,
            expected: expected.exact ?? `${expected.prefix}<Port> ending in ${expected.suffix}`,
          },
        });
      }
    };
    return {
      Program(node): void {
        const detail = pathNamingProblem(file.location);
        if (detail !== undefined) context.report({ node, messageId: "path", data: { path: file.path, detail } });
      },
      "ExportNamedDeclaration > ClassDeclaration"(node: TSESTree.ClassDeclaration): void {
        checkClass(node.id);
      },
      "ExportDefaultDeclaration > ClassDeclaration"(node: TSESTree.ClassDeclaration): void {
        checkClass(node.id);
      },
    };
  },
});
