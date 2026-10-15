// The protected-paths example guard-the-guardrails claims to protect every
// path `bounded init`'s defaults protect. Both files are read as text, never
// imported: the cli is an app and an example is imported by no file. The
// defaults are the template INITIAL_CONFIG in src/cli/initial-config.ts,
// whose text is itself a project's configuration, parsed here as one.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

/** bounded's directory, src/: this file is src/test/guard-the-guardrails-init-defaults.test.ts. */
const SRC = join(import.meta.dir, "..");
const INITIAL_CONFIG_PATH = join(SRC, "cli", "initial-config.ts");
const EXAMPLE_PATH = join(SRC, "packs", "protected-paths", "examples", "guard-the-guardrails.config.ts");
/** The example's rules beyond bounded init's defaults: its generated-code and migrations rules. */
const EXAMPLE_ONLY_MATCHES = ["generated/**", "migrations/**"];

/** One protected-path rule as written in a configuration: each field's literal text, or its strings' texts. */
interface WrittenRule {
  readonly match: string;
  readonly fields: Readonly<Record<string, string | readonly string[]>>;
}

/** The literal text of a string or template literal with no substitutions; undefined for anything else. */
function literalText(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

/** Every object literal in `text` with a string `match`, in source order: the protected-path rules it writes. */
function rulesWrittenIn(path: string, text: string): WrittenRule[] {
  const rules: WrittenRule[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const fields: Record<string, string | readonly string[]> = {};
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
        const { initializer } = property;
        const single = literalText(initializer);
        if (single !== undefined) fields[property.name.text] = single;
        else if (ts.isArrayLiteralExpression(initializer)) fields[property.name.text] = initializer.elements.map((element) => literalText(element) ?? `<not a literal: ${element.getText()}>`);
        else fields[property.name.text] = `<not a literal: ${initializer.getText()}>`;
      }
      const match = fields.match;
      if (typeof match === "string") rules.push({ match, fields });
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true));
  return rules;
}

/** The text of the template `INITIAL_CONFIG` exports, with its escapes resolved, as `bounded init` writes it. */
function initialConfigText(): string {
  const source = ts.createSourceFile(INITIAL_CONFIG_PATH, readFileSync(INITIAL_CONFIG_PATH, "utf8"), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "INITIAL_CONFIG" || declaration.initializer === undefined) continue;
      const text = literalText(declaration.initializer);
      if (text !== undefined) return text;
    }
  }
  throw new Error(`${INITIAL_CONFIG_PATH} has no INITIAL_CONFIG template without substitutions`);
}

describe("guard-the-guardrails and bounded init's defaults", () => {
  test("the example holds each of bounded init's default rules, field for field and in the same order, and only its generated-code and migrations rules besides", () => {
    const defaultRules = rulesWrittenIn("initial-config.template.ts", initialConfigText());
    expect(defaultRules.length).toBeGreaterThan(0);
    const exampleRules = rulesWrittenIn(EXAMPLE_PATH, readFileSync(EXAMPLE_PATH, "utf8"));
    const defaultMatches = new Set(defaultRules.map((rule) => rule.match));
    expect(exampleRules.filter((rule) => defaultMatches.has(rule.match))).toEqual(defaultRules);
    expect(exampleRules.filter((rule) => !defaultMatches.has(rule.match)).map((rule) => rule.match)).toEqual(EXAMPLE_ONLY_MATCHES);
  });
});
