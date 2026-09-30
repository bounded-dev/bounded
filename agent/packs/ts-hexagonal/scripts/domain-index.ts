// A light index of a context's domain concepts: name, kind, area, stem. It is
// what the domain barrel and the feature parser need, and nothing more; the
// full `DomainConceptModel` parser is the ts pack's (WI-3), and its contract
// lint judges the shape. This reader refuses only what would make the barrel
// wrong: a contract in the wrong place, or one without exactly `<Name>` and
// `<Name>Factory` named after its file.

import ts from "typescript";
import type { ConceptKind } from "../../ts/scripts/feature-model.ts";
import { pascalCase } from "../../ts/scripts/naming.ts";
import { ContractShapeError } from "./feature-contract.ts";
import { isAreaName, KEBAB } from "./grammar.ts";

export interface ConceptEntry {
  readonly name: string;
  readonly kind: ConceptKind;
  readonly area: string;
  readonly stem: string;
  readonly contractPath: string;
}

const DOMAIN_PATH = /^contexts\/([^/]+)\/src\/domain\/([^/]+)\/([^/]+)\.contract\.ts$/;

export function readDomainConcept(path: string, source: string): ConceptEntry {
  const where = DOMAIN_PATH.exec(path);
  if (where === null) {
    throw new ContractShapeError(path, "a domain contract lives at contexts/<context>/src/domain/<area>/<concept>.contract.ts");
  }
  const [, , area, stem] = where as unknown as [string, string, string, string];
  if (area !== "shared" && !isAreaName(area)) {
    throw new ContractShapeError(path, `area '${area}' must be a kebab-case plural business noun`);
  }
  if (!KEBAB.test(stem)) throw new ContractShapeError(path, `'${stem}' is not a kebab-case concept name`);
  const name = pascalCase(stem);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement);
  }
  const factory = interfaces.get(`${name}Factory`);
  if (!interfaces.has(name) || factory === undefined) {
    throw new ContractShapeError(path, `declare 'export interface ${name}' and 'export interface ${name}Factory' (the file name fixes the concept name)`);
  }
  const members = factory.members;
  const has = (member: string): boolean =>
    members.some((m) => ts.isMethodSignature(m) && ts.isIdentifier(m.name) && m.name.text === member);
  const kind: ConceptKind = members.some((m) => ts.isConstructSignatureDeclaration(m))
    ? "entity"
    : has("generate") ? "identifier" : "value-object";
  if (kind !== "entity" && !has("parse")) {
    throw new ContractShapeError(path, `${name}Factory needs 'parse(raw: unknown): Result<${name}>' or a 'new (...)' signature`);
  }
  return { name, kind, area, stem, contractPath: path };
}
