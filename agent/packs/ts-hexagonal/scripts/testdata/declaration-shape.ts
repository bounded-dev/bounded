// A skeleton and the file the builder makes of it agree on everything but
// bodies. This reduces a file to exactly that: each class's header,
// constructor parameters and method signatures, plus the type imports it
// takes from its own contract or the application barrel. `async` is dropped:
// the example writes a pass-through `execute()` without it, and the two are
// the same signature to every caller.

import ts from "typescript";

export function declarationShape(source: string): string[] {
  const file = ts.createSourceFile("shape.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const text = (node: ts.Node): string => node.getText(file).replace(/\s+/g, " ").replace(/,\s*\)/g, ")").trim();
  const out: string[] = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const from = (statement.moduleSpecifier as ts.StringLiteral).text;
      if (from.endsWith(".contract.ts") || from.endsWith("/application") || from.endsWith("-database.ts")) {
        out.push(text(statement));
      }
      continue;
    }
    if (!ts.isClassDeclaration(statement)) continue;
    const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
    const heritage = (statement.heritageClauses ?? []).map(text).join(" ");
    out.push(`${exported ? "export " : ""}class ${statement.name?.text ?? "?"} ${heritage}`.trim());
    for (const member of statement.members) {
      if (ts.isConstructorDeclaration(member)) {
        out.push(`  constructor(${member.parameters.map(text).join(", ")})`);
      } else if (ts.isMethodDeclaration(member)) {
        const params = member.parameters.map(text).join(", ");
        out.push(`  ${member.name.getText(file)}(${params}): ${member.type === undefined ? "?" : text(member.type)}`);
      }
    }
  }
  return out;
}
