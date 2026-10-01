// The import rules the shipped architecture.test.ts applies to TEST files,
// said on the test file before red (issue #36).
//
// The architecture test reads every file under the source roots, tests
// included, and fails on a test that imports across a boundary: in the
// 2026-10-01 dogfood every domain test imported its context's
// `@<scope>/<context>/domain` barrel, which a domain file may not do, and
// nothing said so until the architecture test ran at green. The builder's
// boundary rules (boundary-rules.ts) never see test files: the src lint
// leaves them out, and the test lint drops rules that bind the builder.
//
// This rule is the test-writer's half of the same check. It reports exactly
// the problems `boundaryProblems` (eslint/hexagonal.ts) finds, which is the
// one definition the builder's rules use and which reference.test.ts holds
// to the architecture test seed by seed, plus the placement rule. Only on
// test-side files, and with the fix spelled out for a test.

import { existsSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { ESLintUtils } from "@typescript-eslint/utils";
import { boundaryProblems, hexFile, type HexFile, type HexRuleOptions, importVisitors, OPTIONS_SCHEMA, resolveUse, type Use, workspaceIndex, type Workspace } from "../hexagonal.ts";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

const kebab = (pascal: string): string => pascal.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** The file a domain name lives in, relative to the test: `NoteText` from
 *  `domain/notes/` is `./note-text.ts`; `Result` is `../shared/result.ts`. */
function domainFileOf(file: HexFile, name: string): string | undefined {
  if (file.location.workspace !== "context") return undefined;
  const domain = `${file.location.dir}/src/domain`;
  const here = file.path.split("/").slice(0, -1).join("/");
  const relativeTo = (target: string): string => {
    const path = posix.relative(here, target);
    return path.startsWith(".") ? path : `./${path}`;
  };
  if (name === "Result") return relativeTo(`${domain}/shared/result.ts`);
  const stem = kebab(name);
  let areas: string[];
  try {
    areas = readdirSync(join(file.root, domain)).sort();
  } catch {
    return undefined;
  }
  for (const area of areas) {
    if (existsSync(join(file.root, domain, area, `${stem}.contract.ts`)) || existsSync(join(file.root, domain, area, `${stem}.ts`))) {
      return relativeTo(`${domain}/${area}/${stem}.ts`);
    }
  }
  return undefined;
}

/** The fix for one refused import, as a test-writer would apply it. */
function fixFor(file: HexFile, use: Use, index: ReadonlyMap<string, Workspace>): string {
  const from = file.location;
  const target = use.spec === undefined ? undefined : resolveUse(file, use.spec, index);
  const own = target?.kind === "workspace" && from.workspace === "context" && target.workspace.dir === from.dir;
  if (own && from.layer === "domain" && target.subpath === "domain") {
    const names = use.names.filter((n) => n !== "default");
    const lines = names.map((name) => {
      const path = domainFileOf(file, name);
      return path === undefined ? undefined : `import { ${name} } from "${path}";`;
    });
    const example = names.length > 0 && lines.every((l) => l !== undefined)
      ? lines.join(" ")
      : `import { NoteText } from "./note-text.ts";`;
    return `import each name from its own file by relative path: ${example}`;
  }
  if (own && from.layer === "application" && target.subpath === "application") {
    return "an application test imports its feature's files by relative path: the handler from `./<feature>.handler.ts`, " +
      "the command from `./<feature>.command.ts`, types from `./<feature>.contract.ts`; domain values come from `@<scope>/<context>/domain`.";
  }
  if (from.workspace === "context" && from.layer === "adapters-out") {
    return "a store or out-adapter test imports its own technology's files by relative path, the conformance suite from " +
      "`application/…/<feature>.store.test-support.ts` by relative path, and domain values from `@<scope>/<context>/domain`.";
  }
  return "import only what the file under test may import itself (docs/architecture/layers-and-dependencies.md).";
}

/** Test files obey the same import boundaries as the code beside them. */
export const testImports = createRule<[HexRuleOptions?], "problem" | "placement">({
  name: "test-imports",
  meta: {
    type: "problem",
    schema: OPTIONS_SCHEMA,
    messages: {
      problem: "Test import '{{spec}}' breaks a rule architecture.test.ts enforces: {{detail}}. Fix: {{fix}}",
      placement:
        "Test file outside every layer: architecture.test.ts requires every context file to sit in domain/, application/ or " +
        "adapters/in|out/<tech>/. Fix: put the test next to the code it tests (domain/<area>/<concept>.test.ts, " +
        "application/<area>/<feature>/<feature>.test.ts, adapters/out/<tech>/<area>/<feature>.<role>.test.ts).",
    },
  },
  defaultOptions: [{}],
  create(context) {
    const file = hexFile(context.filename, context.cwd);
    if (file === undefined || !file.testSide) return {};
    if (file.location.workspace === "context" && file.location.layer === "none") {
      return { Program(node): void { context.report({ node, messageId: "placement" }); } };
    }
    const index = workspaceIndex(file.root, context.options[0]?.workspaces);
    return importVisitors((use) => {
      const problems = boundaryProblems(file, use, index);
      if (problems.length === 0) return;
      context.report({
        node: use.node,
        messageId: "problem",
        data: { spec: use.spec ?? "(computed)", detail: problems.map((p) => p.message).join("; "), fix: fixFor(file, use, index) },
      });
    });
  },
});
