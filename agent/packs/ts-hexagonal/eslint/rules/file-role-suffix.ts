// Every file under a source root has a role, and its name says which
// (TN-26-012 §1, §2; docs/architecture/directory-structure.md). A file whose
// place and suffix do not match a row of the layout is refused where it is
// written: a stray `utils.ts` in the domain, a handler outside its feature
// folder, a `.tsx` inside a context.

import { ESLintUtils } from "@typescript-eslint/utils";
import { KEBAB, type HexLocation } from "../../scripts/grammar.ts";
import { hexFile } from "../hexagonal.ts";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

const STEM = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
const WORD = "[a-z][a-z0-9]*";
const TESTS = "(?:\\.test|\\.laws\\.test)?";
const ANY_FILE = new RegExp(`^${STEM}(?:\\.${WORD}(?:-${WORD})*)*\\.tsx?$`);
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Why a file's place and name match no row of the layout, or undefined. */
export function fileRoleProblem(location: HexLocation): string | undefined {
  const inner = location.inner;
  const name = inner.at(-1)!;
  // Migrations are the migration generator's; their names are its business.
  if (location.workspace === "context" && location.layer === "adapters-out" && inner[3] === "migrations") return undefined;
  const bad = inner.slice(0, -1).find((dir) => !KEBAB.test(dir));
  if (bad !== undefined) return `folder '${bad}' is not kebab-case`;
  if (!ANY_FILE.test(name)) return `'${name}' is not a kebab-case file name with dotted role suffixes`;
  if (location.workspace === "app") return undefined;
  if (name.endsWith(".tsx")) return "contexts hold no JSX; a .tsx file belongs in an app";
  const matches = (pattern: string): boolean => new RegExp(`^${pattern}$`).test(name);

  switch (location.layer) {
    case "none":
      return "every context file sits in domain/, application/ or adapters/in|out/<tech>/";
    case "domain":
      if (inner.length === 2 && name === "index.ts") return undefined;
      if (inner.length === 3 && matches(`${STEM}(?:\\.contract|\\.test|\\.laws\\.test)?\\.ts`)) return undefined;
      return "domain files are domain/<area>/<concept>.ts, .contract.ts, .test.ts or .laws.test.ts (or the generated domain/index.ts)";
    case "application": {
      if (inner.length === 2 && name === "index.ts") return undefined;
      // Port-level interfaces shared by every feature of the context.
      if (inner.length === 3 && inner[1] === "shared" &&
          (matches(`${STEM}\\.contract\\.ts`) || matches(`${STEM}\\.test\\.ts`) || matches(`${STEM}(?:\\.${WORD})?\\.test-support\\.ts`))) {
        return undefined;
      }
      const feature = inner[2];
      if (inner.length === 4 && feature !== undefined) {
        const f = escape(feature);
        if (matches(`${f}\\.(?:contract|command|handler)\\.ts`) || matches(`${f}\\.test\\.ts`) ||
            matches(`${f}\\.command\\.laws\\.test\\.ts`) || matches(`${f}(?:\\.${WORD})?\\.test-support\\.ts`)) {
          return undefined;
        }
      }
      return "application files are application/<area>/<feature>/<feature>.contract.ts, .command.ts, .handler.ts, " +
        ".test.ts or .<role>.test-support.ts, named after their feature folder, or application/shared/<name>.contract.ts";
    }
    case "adapters-in": {
      const rest = inner.slice(3);
      if (rest.length === 1 && matches(`${STEM}${TESTS}\\.ts`)) return undefined;
      if (rest.length === 2 && matches(`${STEM}\\.${WORD}${TESTS}\\.ts`)) return undefined;
      return "in-adapter files are adapters/in/<tech>/<root file>.ts or adapters/in/<tech>/<area>/<name>.<kind>.ts";
    }
    case "adapters-out": {
      const tech = location.tech ?? "";
      const rest = inner.slice(3);
      if (rest.length === 1 && (name === "index.ts" || name === `${tech}-database.ts` ||
          matches(`${STEM}\\.test-support\\.ts`) || matches(`${STEM}\\.test\\.ts`))) {
        return undefined;
      }
      if (rest[0] === "migrations") return undefined;
      if (rest.length === 2 && rest[0] === "schema" && matches(`${STEM}(?:\\.schema)?\\.ts`)) return undefined;
      if (rest.length === 2 && matches(`${STEM}\\.${WORD}(?:\\.test)?\\.ts`)) return undefined;
      return `out-adapter files are adapters/out/${tech}/<area>/<feature>.<role>.ts or <concept>.mapper.ts, ` +
        `or index.ts and ${tech}-database.ts at the technology root`;
    }
  }
}

export const fileRoleSuffix = createRule<[], "role">({
  name: "file-role-suffix",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      role: "'{{path}}' has no role in the hexagonal layout: {{detail}} (docs/architecture/directory-structure.md)",
    },
  },
  defaultOptions: [],
  create(context) {
    const file = hexFile(context.filename, context.cwd);
    if (file === undefined) return {};
    return {
      Program(node): void {
        const detail = fileRoleProblem(file.location);
        if (detail !== undefined) context.report({ node, messageId: "role", data: { path: file.path, detail } });
      },
    };
  },
});
