// surface-check (TN-26-001): the semantic public-surface gate that makes a
// *.contract.ts binding FOREVER, not just at scaffold time.
//
//   node surface-check.ts [projectRoot [sourceRoot…]]
//
// Finds every <sourceRoot>/**/*.contract.ts (default root `src`; the monorepo
// passes its sourceRoots, e.g. `contexts/*/src`), pairs each with its
// implementation sibling (foo.contract.ts → foo.ts), and compares the two
// PUBLIC SURFACES as sets. Exit 0 clean · 1 violations (one greppable line
// each) · 2 misuse (no contracts found / a contract with no implementation).
//
// WHY THE TYPE CHECKER DOES NOT ALREADY DO THIS. With the canonical
// nominal-class value objects, the implementation's classes are FRESH
// declarations: the private brand makes the contract's `declare class
// Currency` and the implementation's `class Currency` two UNRELATED types, so
// no assignability check ever relates them; the scaffolded `export type * from
// "./x.contract.js"` re-export is shadowed for those names by local-wins; and
// the scaffolder's `__conformance` object deliberately excludes nominal
// classes. Net effect: after scaffold, a contract binds NOTHING about its
// classes. Dogfood Run 8 is the receipt — the builder added a public
// `Money.signed` the contract never declared, and every gate passed.
//
// WHY SEMANTIC, NOT A TEXT DIFF. Diffing the contract against
// `tsc --emitDeclarationOnly` output would bounce forever on member order,
// modifier order, flattened parameter properties and comments. So this check
// is order-, comment- and formatting-insensitive: surfaces are compared as
// sets of (name, kind, staticness, visibility, readonly, optional, type).
// Parameter properties count as the properties they declare; parameter NAMES
// are ignored (types, optionality and rest-ness are not); the `declare`
// modifier is ignored (`private declare readonly __brand` matches the
// contract's `private readonly __brand`).
//
// WHAT IS COMPARED.
//   · Every contract export must have a matching implementation export.
//     Classes compare member-by-member. The private `__brand` and the private
//     constructor must ALSO match — they ARE the nominality, and dropping
//     them is the exact silent degradation this gate exists to catch. A
//     private member's parameter list and (non-brand) types are otherwise
//     implementation detail: the contract's `private constructor();` matches
//     an implementation `private constructor(code: string)`.
//   · Implementation EXTRAS: private/protected members are free. A PUBLIC
//     export, or a public member, the contract does not declare is a
//     violation ("undeclared public surface") — the Money.signed case. An
//     exported const is declared when an exported contract type alias names
//     it through a type-only import from this implementation and `typeof`.
//   · TYPE-ONLY contract exports — interfaces, type aliases (including
//     string-literal unions) and the contract's own `export type { X } from`
//     re-exports — are satisfied by the scaffolded `export type * from
//     "./x.contract.js"` re-export (not resolved structurally — re-exported
//     types CANNOT drift), by a type-only re-export of the name, or by a
//     local declaration of it; flagged only when none of those exists. They
//     are NEVER asked for a runtime export: an interface or a union has no
//     value to export, so demanding one is an impossible instruction (r15
//     spent 4m19 and three worker bounces on exactly that). Only VALUE
//     declarations — classes, functions, consts, enums — require a reachable
//     runtime export.
//
// HONEST LIMITS.
//   · Type comparison is canonicalized TEXT, not type identity: `Array<Foo>`
//     and `Foo[]` count as different, and so does an omitted annotation. The
//     remedy is always the same: write the type exactly as the contract
//     declares it.
//   · A named re-export (`export { X } from "./y.js"`) satisfies presence but
//     its members cannot be checked from this file pair alone; a value-level
//     `export * from` cannot be enumerated at all and is ignored.
//   · Overloaded functions/methods are merged textually (the scaffolder
//     rejects overloaded class members anyway); a contract `readonly`
//     property must be a property in the implementation, not a getter.
//
// DUAL-USE — DO NOT ADD PACK OR HARNESS IMPORTS. This file is copied VERBATIM
// into delivered target projects so they can keep enforcing their contracts
// after the harness is gone. It must import ONLY "ts-morph" and node
// builtins: no other pack scripts, no ../../../src/guard-log.ts (the gate
// wrapper that runs it inside the harness owns guard logging). Pure core
// (compareSurfaces) + thin CLI, pack convention.

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Node, Project, SyntaxKind } from "ts-morph";
import type {
  ClassDeclaration,
  ConstructorDeclaration,
  ExportDeclaration,
  ParameterDeclaration,
  SourceFile,
  TypeNode,
} from "ts-morph";

// --- surface model --------------------------------------------------------------

type Visibility = "public" | "protected" | "private";
type MemberKind = "property" | "method" | "getter" | "setter" | "constructor";
type ExportKind =
  | "class"
  | "function"
  | "const"
  | "interface"
  | "type-alias"
  | "enum"
  | "re-export"
  | "type-re-export";

interface MemberSurface {
  readonly name: string;
  readonly kind: MemberKind;
  readonly isStatic: boolean;
  readonly visibility: Visibility;
  readonly isReadonly: boolean;
  readonly optional: boolean;
  /** Canonicalized type/signature text; UNANNOTATED when none is written. */
  readonly text: string;
}

interface ExportSurface {
  readonly name: string;
  readonly kind: ExportKind;
  readonly members?: readonly MemberSurface[];
  readonly text?: string;
}

interface ModuleSurface {
  readonly exports: ReadonlyMap<string, ExportSurface>;
  readonly typeStarSpecifiers: readonly string[];
}

export type ViolationKind =
  | "missing-export"
  | "export-kind-mismatch"
  | "export-type-mismatch"
  | "missing-member"
  | "member-mismatch"
  | "undeclared-export"
  | "undeclared-member"
  | "missing-type-reexport"
  | "concept-tail";

export interface SurfaceViolation {
  /** The implementation file — where the edit (or the dispute) starts. */
  readonly file: string;
  readonly exportName: string;
  readonly member?: string;
  readonly kind: ViolationKind;
  readonly contractText?: string;
  readonly implText?: string;
  readonly message: string;
}

// --- canonicalization -----------------------------------------------------------

const UNANNOTATED = "<<no type annotation>>";

/** Comment- and whitespace-insensitive type text. Textual, not type identity:
 *  `Array<Foo>` and `Foo[]` stay different on purpose (see header). */
function canonicalType(text: string | undefined): string {
  if (text === undefined) return UNANNOTATED;
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ?([<>(),:;|&[\]{}?=.]) ?/g, "$1")
    .trim();
}

/** Parameter NAMES are not surface; type, optionality and rest-ness are.
 *  An initializer makes a parameter optional, exactly as emit would. */
function paramText(p: ParameterDeclaration): string {
  const optional = p.hasQuestionToken() || p.hasInitializer() ? "?" : "";
  return `${p.isRestParameter() ? "..." : ""}${canonicalType(p.getTypeNode()?.getText())}${optional}`;
}

function signatureText(params: readonly ParameterDeclaration[], ret: TypeNode | undefined): string {
  return `(${params.map(paramText).join(",")})=>${canonicalType(ret?.getText())}`;
}

function pretty(text: string | undefined): string {
  return text === undefined || text === UNANNOTATED ? "(no type annotation)" : text;
}

// --- extraction -----------------------------------------------------------------

function visibilityOf(node: { hasModifier(kind: SyntaxKind): boolean }): Visibility {
  if (node.hasModifier(SyntaxKind.PrivateKeyword)) return "private";
  if (node.hasModifier(SyntaxKind.ProtectedKeyword)) return "protected";
  return "public";
}

function constructorSurface(ctor: ConstructorDeclaration): MemberSurface {
  return {
    name: "constructor",
    kind: "constructor",
    isStatic: false,
    visibility: visibilityOf(ctor),
    isReadonly: false,
    optional: false,
    text: `(${ctor.getParameters().map(paramText).join(",")})`,
  };
}

function classMembers(cls: ClassDeclaration): MemberSurface[] {
  const members: MemberSurface[] = [];
  for (const m of cls.getMembers()) {
    if (Node.isConstructorDeclaration(m)) {
      // Overload declarations share one visibility; keep the first.
      if (!members.some((x) => x.kind === "constructor")) members.push(constructorSurface(m));
      // A parameter property IS a property declaration — the flattened form
      // a text diff would trip over.
      for (const p of m.getParameters()) {
        if (!p.isParameterProperty()) continue;
        members.push({
          name: p.getName(),
          kind: "property",
          isStatic: false,
          visibility: visibilityOf(p),
          isReadonly: p.isReadonly(),
          optional: p.hasQuestionToken(),
          text: canonicalType(p.getTypeNode()?.getText()),
        });
      }
      continue;
    }
    if (Node.isMethodDeclaration(m)) {
      if (m.getName().startsWith("#")) continue; // ES-private: never surface
      members.push({
        name: m.getName(),
        kind: "method",
        isStatic: m.isStatic(),
        visibility: visibilityOf(m),
        isReadonly: false,
        optional: m.hasQuestionToken(),
        text: signatureText(m.getParameters(), m.getReturnTypeNode()),
      });
      continue;
    }
    if (Node.isPropertyDeclaration(m)) {
      if (m.getName().startsWith("#")) continue;
      members.push({
        name: m.getName(),
        kind: "property",
        isStatic: m.isStatic(),
        visibility: visibilityOf(m),
        isReadonly: m.isReadonly(),
        optional: m.hasQuestionToken(),
        text: canonicalType(m.getTypeNode()?.getText()),
      });
      continue;
    }
    if (Node.isGetAccessorDeclaration(m)) {
      members.push({
        name: m.getName(),
        kind: "getter",
        isStatic: m.isStatic(),
        visibility: visibilityOf(m),
        isReadonly: false,
        optional: false,
        text: canonicalType(m.getReturnTypeNode()?.getText()),
      });
      continue;
    }
    if (Node.isSetAccessorDeclaration(m)) {
      members.push({
        name: m.getName(),
        kind: "setter",
        isStatic: m.isStatic(),
        visibility: visibilityOf(m),
        isReadonly: false,
        optional: false,
        text: canonicalType(m.getParameters()[0]?.getTypeNode()?.getText()),
      });
      continue;
    }
    // static blocks, index signatures: not part of the compared surface.
  }
  return mergeOverloads(members);
}

/** Same-name method declarations (overloads) merge into one sorted textual
 *  signature set, so declaration order never matters. */
function mergeOverloads(members: MemberSurface[]): MemberSurface[] {
  const out: MemberSurface[] = [];
  for (const m of members) {
    const at = out.findIndex((x) => x.name === m.name && x.isStatic === m.isStatic && x.kind === m.kind);
    if (at >= 0 && m.kind === "method") {
      const prev = out[at] as MemberSurface;
      out[at] = { ...prev, text: [...prev.text.split(" | "), m.text].sort().join(" | ") };
    } else {
      out.push(m);
    }
  }
  return out;
}

function localSurface(sf: SourceFile, localName: string, exportedName: string): ExportSurface | undefined {
  const cls = sf.getClass(localName);
  if (cls !== undefined) return { name: exportedName, kind: "class", members: classMembers(cls) };
  const fns = sf.getFunctions().filter((f) => f.getName() === localName);
  if (fns.length > 0) {
    const texts = fns.map((f) => signatureText(f.getParameters(), f.getReturnTypeNode())).sort();
    return { name: exportedName, kind: "function", text: texts.join(" | ") };
  }
  if (sf.getInterface(localName) !== undefined) return { name: exportedName, kind: "interface" };
  if (sf.getTypeAlias(localName) !== undefined) return { name: exportedName, kind: "type-alias" };
  if (sf.getEnum(localName) !== undefined) return { name: exportedName, kind: "enum" };
  const v = sf.getVariableDeclaration(localName);
  if (v !== undefined) return { name: exportedName, kind: "const", text: canonicalType(v.getTypeNode()?.getText()) };
  return undefined;
}

function collectExportDeclaration(
  sf: SourceFile,
  decl: ExportDeclaration,
  put: (e: ExportSurface) => void,
  typeStar: string[],
): void {
  const specifier = decl.getModuleSpecifierValue();
  const named = decl.getNamedExports();
  if (named.length === 0) {
    // `export type * from` is the protocol for contract types; a value-level
    // `export *` cannot be enumerated from this file alone (header limit).
    if (decl.isTypeOnly() && specifier !== undefined) typeStar.push(specifier);
    return;
  }
  for (const ne of named) {
    const exportedName = ne.getAliasNode()?.getText() ?? ne.getName();
    const typeOnly = decl.isTypeOnly() || ne.isTypeOnly();
    if (specifier === undefined) {
      // `export { X }` — X is a local declaration; read its real shape.
      put(
        localSurface(sf, ne.getName(), exportedName) ?? {
          name: exportedName,
          kind: typeOnly ? "type-re-export" : "re-export",
        },
      );
    } else {
      put({ name: exportedName, kind: typeOnly ? "type-re-export" : "re-export" });
    }
  }
}

function moduleSurface(sf: SourceFile): ModuleSurface {
  const exports = new Map<string, ExportSurface>();
  const typeStarSpecifiers: string[] = [];

  const put = (e: ExportSurface): void => {
    const prev = exports.get(e.name);
    if (prev !== undefined && prev.kind === "function" && e.kind === "function") {
      // Function overload declarations: merge to one sorted signature set.
      const texts = [...(prev.text ?? "").split(" | "), e.text ?? ""].filter((t) => t !== "").sort();
      exports.set(e.name, { ...prev, text: texts.join(" | ") });
      return;
    }
    exports.set(e.name, e);
  };

  for (const stmt of sf.getStatements()) {
    if (Node.isExportDeclaration(stmt)) {
      collectExportDeclaration(sf, stmt, put, typeStarSpecifiers);
    } else if (Node.isClassDeclaration(stmt) && stmt.hasExportKeyword()) {
      const name = stmt.getName();
      if (name !== undefined) put({ name, kind: "class", members: classMembers(stmt) });
    } else if (Node.isFunctionDeclaration(stmt) && stmt.hasExportKeyword()) {
      const name = stmt.getName();
      if (name !== undefined)
        put({ name, kind: "function", text: signatureText(stmt.getParameters(), stmt.getReturnTypeNode()) });
    } else if (Node.isVariableStatement(stmt) && stmt.hasExportKeyword()) {
      for (const d of stmt.getDeclarations())
        put({ name: d.getName(), kind: "const", text: canonicalType(d.getTypeNode()?.getText()) });
    } else if (Node.isInterfaceDeclaration(stmt) && stmt.hasExportKeyword()) {
      put({ name: stmt.getName(), kind: "interface" });
    } else if (Node.isTypeAliasDeclaration(stmt) && stmt.hasExportKeyword()) {
      put({ name: stmt.getName(), kind: "type-alias" });
    } else if (Node.isEnumDeclaration(stmt) && stmt.hasExportKeyword()) {
      put({ name: stmt.getName(), kind: "enum" });
    }
  }
  return { exports, typeStarSpecifiers };
}

/** A contract can declare an inferred implementation value through an exported
 * `typeof` alias. Count only direct, type-only named imports from this exact
 * implementation sibling; other imports and unexported aliases do not widen
 * the public surface. */
function typeQueriedImplementationValues(contract: SourceFile, implFileName: string): ReadonlySet<string> {
  const specifier = `./${basename(implFileName).replace(/\.tsx?$/, ".js")}`;
  const imported = new Map<string, string>();
  for (const declaration of contract.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== specifier) continue;
    for (const named of declaration.getNamedImports()) {
      if (!declaration.isTypeOnly() && !named.isTypeOnly()) continue;
      imported.set(named.getAliasNode()?.getText() ?? named.getName(), named.getName());
    }
  }
  const values = new Set<string>();
  for (const alias of contract.getTypeAliases()) {
    if (!alias.isExported()) continue;
    const type = alias.getTypeNode();
    if (!type || !Node.isTypeQuery(type)) continue;
    const name = imported.get(type.getExprName().getText());
    if (name !== undefined) values.add(name);
  }
  return values;
}

// --- comparison (pure core) -----------------------------------------------------

const EXACT = "write it exactly as the contract declares it (comparison is canonicalized text: Array<Foo> vs Foo[] is a mismatch)";
const DISPUTE = "the architect's call — raise CONTRACT-DISPUTE if you are the builder";

function describeMember(className: string, m: MemberSurface): string {
  const vis = m.visibility === "public" ? "" : `${m.visibility} `;
  return `${vis}${m.isStatic ? "static " : ""}${m.kind} '${className}.${m.name}'`;
}

function compareClassMembers(
  className: string,
  cms: readonly MemberSurface[],
  ims: readonly MemberSurface[],
  contractFileName: string,
  implFileName: string,
  out: SurfaceViolation[],
): void {
  const v = (partial: Omit<SurfaceViolation, "file" | "exportName">): void => {
    out.push({ file: implFileName, exportName: className, ...partial });
  };

  for (const cm of cms) {
    const byName = ims.filter((m) => m.name === cm.name && m.isStatic === cm.isStatic);
    const im = byName.find((m) => m.kind === cm.kind) ?? byName[0];

    if (im === undefined) {
      if (cm.kind === "constructor") {
        // No written constructor means an implicit PUBLIC one.
        if (cm.visibility !== "public") {
          v({
            member: cm.name,
            kind: "missing-member",
            message: `${className}.constructor: the contract declares a ${cm.visibility} constructor and the implementation writes none, leaving an implicit PUBLIC constructor — anyone can \`new ${className}(...)\` around parse, which breaks nominality; write \`private constructor(...) {}\``,
          });
        }
        continue;
      }
      const brand = cm.name === "__brand" ? " — the private brand IS the nominality; dropping it silently degrades the class to a structural type" : "";
      v({
        member: cm.name,
        kind: "missing-member",
        contractText: cm.text,
        message: `${className}.${cm.name}: the contract declares ${describeMember(className, cm)} and the implementation has no such member${brand}; add it exactly as the contract declares it`,
      });
      continue;
    }

    if (im.kind !== cm.kind) {
      v({
        member: cm.name,
        kind: "member-mismatch",
        contractText: cm.kind,
        implText: im.kind,
        message: `${className}.${cm.name}: the contract declares a ${cm.kind} and the implementation has a ${im.kind}; declare it as a ${cm.kind}, exactly as the contract does`,
      });
      continue;
    }

    if (cm.visibility === "private") {
      // A private member's parameter list and types are invisible outside the
      // class — implementation detail — EXCEPT the brand's type text, which is
      // the nominal token itself.
      if (im.visibility !== "private") {
        const ctor = cm.kind === "constructor" ? " — a public constructor bypasses parse and breaks nominality" : "";
        v({
          member: cm.name,
          kind: "member-mismatch",
          contractText: "private",
          implText: im.visibility,
          message: `${className}.${cm.name}: the contract declares it private and the implementation makes it ${im.visibility}${ctor}; make it private`,
        });
      } else if (cm.kind === "property" && (im.text !== cm.text || im.isReadonly !== cm.isReadonly)) {
        v({
          member: cm.name,
          kind: "member-mismatch",
          contractText: cm.text,
          implText: im.text,
          message: `${className}.${cm.name}: the contract declares \`private ${cm.isReadonly ? "readonly " : ""}${cm.name}: ${pretty(cm.text)}\` and the implementation has \`private ${im.isReadonly ? "readonly " : ""}${im.name}: ${pretty(im.text)}\`; ${EXACT}`,
        });
      }
      continue;
    }

    if (im.visibility !== cm.visibility) {
      v({
        member: cm.name,
        kind: "member-mismatch",
        contractText: cm.visibility,
        implText: im.visibility,
        message: `${className}.${cm.name}: the contract declares it ${cm.visibility} and the implementation makes it ${im.visibility}; make it ${cm.visibility}`,
      });
      continue;
    }

    const diffs: string[] = [];
    if (cm.isReadonly !== im.isReadonly)
      diffs.push(cm.isReadonly ? "the contract says readonly, the implementation is mutable" : "the implementation adds readonly the contract does not declare");
    if (cm.optional !== im.optional)
      diffs.push(cm.optional ? "the contract says optional (?), the implementation makes it required" : "the implementation adds ? the contract does not declare");
    if (cm.text !== im.text)
      diffs.push(`the contract declares ${pretty(cm.text)} and the implementation ${pretty(im.text)}`);
    if (diffs.length > 0) {
      v({
        member: cm.name,
        kind: "member-mismatch",
        contractText: cm.text,
        implText: im.text,
        message: `${className}.${cm.name}: ${diffs.join("; ")}; ${EXACT}`,
      });
    }
  }

  // Extras: private/protected members are implementation detail; PUBLIC
  // members the contract never declared are undeclared public surface.
  for (const im of ims) {
    if (im.visibility !== "public") continue;
    // An explicit public constructor where the contract declares none equals
    // the implicit one the contract already implies.
    if (im.kind === "constructor" && !cms.some((c) => c.kind === "constructor")) continue;
    if (cms.some((c) => c.name === im.name && c.isStatic === im.isStatic)) continue;
    v({
      member: im.name,
      kind: "undeclared-member",
      implText: im.text,
      message: `${className}.${im.name}: public ${im.isStatic ? "static " : ""}${im.kind} not declared by ${contractFileName} — undeclared public surface; make it private, or have the contract declare it (${DISPUTE})`,
    });
  }
}

/** Contract exports that declare a TYPE and nothing else. No runtime value
 *  exists for these by construction, so they can only ever be satisfied
 *  type-only — never by a value export. `type-re-export` belongs here: a
 *  contract that says `export type { BillingInterval } from "./x.js"` is
 *  declaring a type, whatever the module it borrows it from. */
function isTypeOnlyExport(kind: ExportKind): boolean {
  return kind === "interface" || kind === "type-alias" || kind === "type-re-export";
}

/** Does an `export type * from "<specifier>"` point back at this contract? */
function typeStarMatches(specifier: string, contractFileName: string): boolean {
  const stem = basename(contractFileName).replace(/\.ts$/, ""); // "money.contract"
  const spec = specifier.split("/").pop() ?? specifier;
  return spec.replace(/\.d\.ts$|\.ts$|\.js$/, "") === stem;
}

// --- the contract-owns-the-name form (ADR 2026-059) -------------------------------
//
// A concept contract is `interface <Name>` (branded) + `interface
// <Name>Factory`, and its implementation hides `<Name>Impl` and ends with
// `export type <Name> = Contract.<Name>;` and
// `export const <Name>: Contract.<Name>Factory = <Name>Impl;`. The compiler
// checks both sides of that pair (the `implements` clause and the const's
// factory annotation), so member-by-member comparison would only duplicate
// it. What the compiler cannot see is surface ADDED beside the tail, or a
// tail edited so that it stops checking — those are this section's.

/** The concept a contract declares in the ADR 2026-059 form, or undefined. */
function conceptNameOf(contract: SourceFile): string | undefined {
  const exported = contract.getInterfaces().filter((i) => i.isExported());
  for (const iface of exported) {
    const name = iface.getName();
    const branded = iface.getProperty("__brand") !== undefined;
    if (branded && exported.some((f) => f.getName() === `${name}Factory`)) return name;
  }
  return undefined;
}

function compareConceptImplementation(
  name: string,
  contractFileName: string,
  impl: SourceFile,
  implFileName: string,
): SurfaceViolation[] {
  const out: SurfaceViolation[] = [];
  const tail = [`export type ${name} = Contract.${name};`, `export const ${name}: Contract.${name}Factory = ${name}Impl;`];
  const statements = impl.getStatements();
  const last = statements.slice(-2).map((st) => st.getText());
  if (last[0] !== tail[0] || last[1] !== tail[1]) {
    out.push({
      file: implFileName,
      exportName: name,
      kind: "concept-tail",
      message: `${name}: ${implFileName} must end with exactly the two generated exports, which make ${contractFileName}'s interface the one type named ${name} and check ${name}Impl against ${name}Factory (ADR 2026-059):\n${tail.join("\n")}`,
    });
  }
  for (const [exported, declarations] of impl.getExportedDeclarations()) {
    if (exported === name) continue;
    const kind = declarations[0]?.getKindName() ?? "declaration";
    out.push({
      file: implFileName,
      exportName: exported,
      kind: "undeclared-export",
      message: `${exported}: the implementation exports ${kind} '${exported}', which ${contractFileName} does not declare — a concept's implementation exports only '${name}' (the tail); keep '${exported}' module-local or move it to its own module (${DISPUTE})`,
    });
  }
  return out;
}

/**
 * Compare the contract's exported surface against the implementation's.
 * Pure: strings in, typed violations out; no I/O, no logging, no exit codes.
 */
export function compareSurfaces(
  contractSource: string,
  contractFileName: string,
  implSource: string,
  implFileName: string,
): SurfaceViolation[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const contractFile = project.createSourceFile("/__contract__.ts", contractSource);
  const concept = conceptNameOf(contractFile);
  if (concept !== undefined) {
    return compareConceptImplementation(concept, contractFileName, project.createSourceFile("/__impl__.ts", implSource), implFileName);
  }
  const contract = moduleSurface(contractFile);
  const typeQueriedValues = typeQueriedImplementationValues(contractFile, implFileName);
  // The scratch name carries the implementation's REAL extension: ts-morph
  // decides whether `<Badge />` is JSX or a type assertion from the filename,
  // and a component parsed as `.ts` is a pile of syntax errors whose surface is
  // whatever survived the wreck — a silent pass where the gate must be exact.
  const impl = moduleSurface(
    project.createSourceFile(implFileName.endsWith(".tsx") ? "/__impl__.tsx" : "/__impl__.ts", implSource),
  );
  const hasTypeStar = impl.typeStarSpecifiers.some((s) => typeStarMatches(s, contractFileName));
  const out: SurfaceViolation[] = [];

  for (const ce of contract.exports.values()) {
    const ie = impl.exports.get(ce.name);

    if (isTypeOnlyExport(ce.kind)) {
      // Satisfied by the scaffolded type-star re-export (types that are
      // re-exported cannot drift, so it is never resolved structurally), by a
      // type-only re-export of the name, or by a local declaration of it.
      // PRESENCE is the whole test: there is no runtime value to look for.
      if (hasTypeStar || ie !== undefined) continue;
      const stem = basename(contractFileName).replace(/\.ts$/, "");
      const declared = ce.kind === "type-re-export" ? "type" : ce.kind;
      out.push({
        file: implFileName,
        exportName: ce.name,
        kind: "missing-type-reexport",
        message: `${ce.name}: the contract declares ${declared} '${ce.name}' but the implementation neither re-exports the contract's types nor declares '${ce.name}' locally; add \`export type * from "./${stem}.js";\` — one line satisfies every contract type and cannot drift`,
      });
      continue;
    }

    if (ie === undefined) {
      out.push({
        file: implFileName,
        exportName: ce.name,
        kind: "missing-export",
        message: `${ce.name}: the contract declares ${ce.kind} '${ce.name}' and the implementation exports no '${ce.name}'; export a ${ce.kind} named ${ce.name} implementing the contract's surface exactly`,
      });
      continue;
    }
    if (ie.kind === "type-re-export") {
      // Reachable only for a VALUE contract export (the type-only kinds all
      // continued above), so asking for a runtime export is always possible.
      out.push({
        file: implFileName,
        exportName: ce.name,
        kind: "export-kind-mismatch",
        contractText: ce.kind,
        implText: "type-only re-export",
        message: `${ce.name}: the contract declares ${ce.kind} '${ce.name}' but the implementation only re-exports it type-only, which is erased at runtime; export the value (drop the \`type\` keyword or declare it locally)`,
      });
      continue;
    }
    if (ie.kind === "re-export") continue; // presence satisfied; members unverifiable from this pair (header limit)
    if (ie.kind !== ce.kind) {
      out.push({
        file: implFileName,
        exportName: ce.name,
        kind: "export-kind-mismatch",
        contractText: ce.kind,
        implText: ie.kind,
        message: `${ce.name}: the contract declares a ${ce.kind} and the implementation exports a ${ie.kind}; declare it as a ${ce.kind}, exactly as the contract does`,
      });
      continue;
    }

    if (ce.kind === "class") {
      compareClassMembers(ce.name, ce.members ?? [], ie.members ?? [], contractFileName, implFileName, out);
    } else if (ce.kind === "function" || ce.kind === "const") {
      if (ce.text !== ie.text) {
        out.push({
          file: implFileName,
          exportName: ce.name,
          kind: "export-type-mismatch",
          contractText: ce.text,
          implText: ie.text,
          message: `${ce.name}: the contract declares ${pretty(ce.text)} and the implementation ${pretty(ie.text)}; ${EXACT}`,
        });
      }
    }
    // enums: presence + kind only (the pack's declaration-only rule bans them anyway).
  }

  // Implementation extras: every export is public surface, so an export the
  // contract does not declare is a violation — including named re-exports
  // that funnel other modules' classes through this one (Run 8's
  // subscription-billing.ts re-exported nine value classes this way).
  for (const ie of impl.exports.values()) {
    if (contract.exports.has(ie.name)) continue;
    if (ie.kind === "const" && typeQueriedValues.has(ie.name)) continue;
    const what =
      ie.kind === "re-export" || ie.kind === "type-re-export"
        ? `re-exports '${ie.name}' from another module`
        : `exports ${ie.kind} '${ie.name}'`;
    out.push({
      file: implFileName,
      exportName: ie.name,
      kind: "undeclared-export",
      implText: ie.text,
      message: `${ie.name}: the implementation ${what}, which ${contractFileName} does not declare — undeclared public surface; stop exporting it (keep it module-local, or drop the re-export), or have the contract declare it (${DISPUTE})`,
    });
  }

  return out;
}

// --- project walk (IO wrapper) --------------------------------------------------

const CONTRACT_SUFFIX = ".contract.ts";

function walkContracts(root: string, dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkContracts(root, full, out);
    else if (entry.name.endsWith(CONTRACT_SUFFIX)) out.push(relative(root, full).split(sep).join("/"));
  }
  return out.sort();
}

export interface SurfaceCheckRun {
  readonly code: 0 | 1 | 2;
  readonly lines: readonly string[];
  readonly violations: readonly SurfaceViolation[];
}

/** The concrete directories a source-root glob names: each segment literal
 *  or exactly `*` (one directory level), as the sourceRoots socket allows
 *  (ADR 2026-056). Sorted; directories only. */
function expandRoot(root: string, glob: string): string[] {
  let dirs = [""];
  for (const segment of glob.split("/")) {
    const next: string[] = [];
    for (const dir of dirs) {
      const abs = join(root, dir);
      if (segment !== "*") {
        const candidate = dir === "" ? segment : `${dir}/${segment}`;
        if (existsSync(join(root, candidate))) next.push(candidate);
        continue;
      }
      if (!existsSync(abs)) continue;
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          next.push(dir === "" ? entry.name : `${dir}/${entry.name}`);
        }
      }
    }
    dirs = next;
  }
  return dirs.sort();
}

/** Every concrete directory the source-root globs name under `root`,
 *  project-relative, sorted and deduplicated. */
export function expandSourceRoots(root: string, globs: readonly string[]): string[] {
  return [...new Set(globs.flatMap((glob) => expandRoot(root, glob)))].sort();
}

/** A feature contract in the hexagonal application layer (TN-26-012) is
 *  implemented by generated and handler files, not by a `<feature>.ts`
 *  sibling, so it is not a surface pair. */
function isFeatureContract(rel: string): boolean {
  return /(^|\/)application\/[^/]+\/[^/]+\/[^/]+\.contract\.ts$/.test(rel);
}

/** Find every *.contract.ts under the source roots (`src` unless the caller
 *  passes the composition's `sourceRoots`, ADR 2026-056), pair each with its
 *  sibling implementation, and compare. One implementation of the verdict for
 *  the CLI and the gate wrappers alike. */
export function checkProjectSurfaces(root: string, sourceRoots: readonly string[] = ["src"]): SurfaceCheckRun {
  const dirs = expandSourceRoots(root, sourceRoots);
  const contracts = dirs.flatMap((dir) => walkContracts(root, join(root, dir))).filter((rel) => !isFeatureContract(rel)).sort();
  if (contracts.length === 0) {
    const where = sourceRoots.map((r) => `${r}/**/*.contract.ts`).join(", ");
    return {
      code: 2,
      violations: [],
      lines: [`surface-check: no ${where} found — a gate that matches nothing is a broken gate`],
    };
  }

  const lines: string[] = [];
  const violations: SurfaceViolation[] = [];
  let misuse = false;
  for (const rel of contracts) {
    // Either sibling extension is a legal implementation: a contract declaring
    // a React component scaffolds to `foo.tsx` (TN-26-006 A1), and a gate that
    // only looked for `foo.ts` would call every component in the tree missing.
    // `.ts` wins a tie, which the scaffolder's sync makes unreachable anyway —
    // it writes one and prunes the other.
    const stem = rel.slice(0, -CONTRACT_SUFFIX.length);
    const implRel = [`${stem}.ts`, `${stem}.tsx`].find((p) => existsSync(join(root, p)));
    if (implRel === undefined) {
      misuse = true;
      lines.push(
        `surface-check: ERROR — ${rel} has no implementation sibling ${stem}.ts or ${stem}.tsx (foo.contract.ts is implemented by foo.ts, or foo.tsx when it declares a component; run the scaffolder)`,
      );
      continue;
    }
    const found = compareSurfaces(
      readFileSync(join(root, rel), "utf8"),
      rel,
      readFileSync(join(root, implRel), "utf8"),
      implRel,
    );
    violations.push(...found);
    lines.push(...found.map((f) => `surface-check: FAIL ${f.file} — ${f.message}`));
  }

  if (misuse) return { code: 2, violations, lines };
  const pairs = `${contracts.length} contract pair${contracts.length === 1 ? "" : "s"}`;
  if (violations.length > 0) {
    return {
      code: 1,
      violations,
      lines: [...lines, `surface-check: ${violations.length} violation${violations.length === 1 ? "" : "s"} across ${pairs}`],
    };
  }
  return { code: 0, violations, lines: [`surface-check: OK (${pairs})`] };
}

// --- CLI ------------------------------------------------------------------------

function main(argv: string[]): number {
  const [root, ...roots] = argv;
  const result = checkProjectSurfaces(root ?? process.cwd(), roots.length > 0 ? roots : undefined);
  for (const line of result.lines) {
    if (result.code === 2) console.error(line);
    else console.log(line);
  }
  return result.code;
}

// Symlink-safe main check (invoked via the ~/.pi/agent symlink): compare realpaths.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exit(main(process.argv.slice(2)));
}
