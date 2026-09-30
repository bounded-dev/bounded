// Port-level interfaces shared by every feature of a context (a clock, an
// event publisher) live in `application/shared/<name>.contract.ts`, as the
// worked example's application.md allows. This reader checks what the
// application barrel and the feature parser rely on: the file holds exported
// interfaces only, imports only types from the domain barrel or another
// shared contract, and carries no feature tags.

import ts from "typescript";
import { ContractShapeError } from "./feature-contract.ts";
import { PASCAL } from "./grammar.ts";

export interface SharedContract {
  /** `contexts/<context>/src/application/shared/<stem>.contract.ts` */
  readonly path: string;
  readonly stem: string;
  /** Exported interface names, sorted. */
  readonly names: readonly string[];
}

const SHARED_PATH = /^contexts\/([^/]+)\/src\/application\/shared\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.contract\.ts$/;
const SIBLING = /^\.\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.contract\.ts$/;

export function readSharedContract(path: string, source: string, scope: string): SharedContract {
  const refuse = (problem: string): never => {
    throw new ContractShapeError(path, problem);
  };
  const where = SHARED_PATH.exec(path);
  if (where === null) return refuse("a shared port lives at contexts/<context>/src/application/shared/<name>.contract.ts");
  const [, context, stem] = where as unknown as [string, string, string];
  const domainImport = `${scope}/${context}/domain`;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const syntax = (file as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntax.length > 0) refuse(`does not parse: ${ts.flattenDiagnosticMessageText(syntax[0]!.messageText, " ")}`);
  if (/@(exposedvia|implementedby)\b/i.test(source)) refuse("@exposedVia and @implementedBy belong on feature contracts, not shared ports");
  const names: string[] = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
      if (statement.importClause?.isTypeOnly !== true || (specifier !== domainImport && !SIBLING.test(specifier))) {
        refuse(`a shared port imports only types, from "${domainImport}" or another ./<name>.contract.ts`);
      }
      continue;
    }
    if (ts.isInterfaceDeclaration(statement) && statement.modifiers?.length === 1 &&
        statement.modifiers[0]!.kind === ts.SyntaxKind.ExportKeyword && PASCAL.test(statement.name.text)) {
      names.push(statement.name.text);
      continue;
    }
    refuse("a shared contract holds type imports and 'export interface' declarations only");
  }
  if (names.length === 0) refuse("a shared contract declares at least one exported interface");
  return { path, stem, names: [...names].sort() };
}
