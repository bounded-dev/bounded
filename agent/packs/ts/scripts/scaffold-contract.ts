// Scaffolder (TN-26-001): contract → throwing skeleton.
//
//   src/orders/orders.contract.ts  →  src/orders/orders.ts   (fixed naming rule)
//   src/ui/badge.contract.ts       →  src/ui/badge.tsx       (declares a component)
//
// Contracts are always `.ts` — declaration-only files have no JSX to spell —
// but a contract whose exported surface returns a React element scaffolds to a
// `.tsx` sibling, because the builder's replacement for that skeleton will
// contain JSX and JSX in a `.ts` file does not parse (TN-26-006 A1).
//
// Pure core (scaffoldContract: string → string) + thin CLI. Skeletons are
// machine-generated, never agent-written: nothing to police, and the red
// gate gets a guaranteed NotImplementedError failure reason. Contracts that
// can't be scaffolded fail loudly with ScaffoldError — the architect fixes
// the contract, never the skeleton.
//
// Built on ts-morph (AST in, CodeBlockWriter out): signature *text* is
// echoed verbatim from the contract — no `as` casts, no `any` — so
// skeleton/contract drift is a compile error, not an assertion. Overloads
// keep their declared signatures plus an unknown-typed implementation
// signature. NotImplementedError lives in the project's shared errors
// module (template convention: <root>/shared/errors.ts) so its identity is
// stable across components and gates.
//
// ONE CLASS IDENTITY PER VALUE OBJECT (ADR 2026-023). A contract's
// `declare class Money` and the runtime `class Money` in its sibling
// implementation module are two declarations of the same private `__brand`,
// and TypeScript treats those as unrelated nominal types. So a contract may
// NOT import types from another contract's `*.contract.ts`: it imports them
// from that contract's IMPLEMENTATION module (`../values/values.js`), which
// re-exports every type its contract declares and shadows the ambient class
// with the real one. Anything else is rejected below, loudly, with the fix.
//
// v1 known limits (fail loudly, by design): enums (use string-literal
// unions — the declaration-only lint rule agrees), value exports inside
// namespaces, default-exported values, `export =`, computed member names,
// overloaded class methods/constructors.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeBlockWriter, Node, Project, SyntaxKind } from "ts-morph";
// Harness-core guard log (NOTE: this relative import only resolves when the
// pack runs inside the harness checkout; pack distribution is issue #4).
import { logGuardEvent } from "../../../src/guard-log.ts";
import { lawsPathFor, ValueObjectLawsError, valueObjectLawsSource, valueObjectsOf } from "./value-object-laws.ts";
import { findContractFiles, findFilesUnder } from "./checksum-gate.ts";
import { mergedContribution } from "../../../src/pack-contrib.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";
import { composedPacks } from "../../installed.ts";
import { contractSupportFiles, type ContractSupportFile } from "../pack.ts";
import { containedSupportTargets } from "./support-targets.ts";
import type {
  ClassDeclaration,
  ClassMemberTypes,
  FunctionDeclaration,
  GetAccessorDeclaration,
  MethodDeclaration,
  PropertyDeclaration,
  SetAccessorDeclaration,
  SourceFile,
  VariableStatement,
} from "ts-morph";

type NamedClassMember =
  | MethodDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration
  | PropertyDeclaration;

export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaffoldError";
  }
}

const CONTRACT_SUFFIX = ".contract.ts";

/** Canonical content of the template's shared errors module — single source
 *  of truth for the CLI (auto-create), the bootstrapper, and tests. */
export const ERRORS_MODULE_SOURCE = `export class NotImplementedError extends Error {
  constructor(what: string) {
    super(\`NotImplemented: \${what}\`);
    this.name = "NotImplementedError";
  }
}

export function notImplemented(what: string): never {
  throw new NotImplementedError(what);
}
`;

/**
 * The React types whose presence on a contract's exported surface makes its
 * skeleton a `.tsx` file (TN-26-006 A1).
 *
 * WHY A NAME LIST AND NOT A TYPE CHECK. The generated set must be a pure
 * function of the CONTRACT set — that is the whole scaffolder invariant (a
 * skeleton is reproducible in the red gate's shadow project at any moment, from
 * the frozen contracts and nothing else). A judgement that needed the project's
 * resolved types would make the extension depend on node_modules, so the rule
 * reads the contract's own text against a list of component return-type names.
 *
 * THE NAMES ARE NOT TS-PACK CONTENT (TN-26-005). "ReactElement" is web-pack
 * knowledge; this scaffolder is the socket. The names arrive as pack
 * contributions (`componentReturnTypes` in packs/ts-web/contrib.json), merged
 * across the project’s selected packs — a harness composed without
 * the web pack never emits a .tsx skeleton, because nothing contributed a
 * component type to look for.
 */
export function componentTypeNames(cwd: string): ReadonlySet<string> {
  return new Set(mergedContribution("componentReturnTypes", readProjectPacks(cwd)));
}

/**
 * `.tsx` if this contract declares a React component on its exported surface,
 * `.ts` otherwise.
 *
 * The skeleton's CONTENT never changes — every export throws
 * NotImplementedError, and a throw contains no JSX. Only the extension does,
 * and it has to: the builder replaces the skeleton with a real component whose
 * body is JSX, and JSX in a `.ts` file is a syntax error, so a `.ts` skeleton
 * would force the builder's first act to be renaming a generated file. That is
 * a file the builder's zone does not own and the sync would immediately treat
 * as an orphan.
 *
 * Deliberately TOTAL over the file: any exported declaration referencing one of
 * the component types makes the WHOLE skeleton `.tsx`. A `.tsx` file compiles
 * every `.ts` construct, so the wider answer is never wrong — only occasionally
 * generous — whereas splitting one contract across two extensions is not a
 * thing the fixed naming rule can express.
 *
 * Unparseable input answers `.ts`: this is a naming decision taken before
 * `scaffoldContract` has had its say, and the contract's real defects belong in
 * that function's loud, specific ScaffoldError — not in a mystery extension.
 */
export function skeletonExtensionFor(
  contractSource: string,
  names: ReadonlySet<string> = new Set(),
): ".ts" | ".tsx" {
  if (names.size === 0) return ".ts"; // no pack contributed component types
  let sf: SourceFile;
  try {
    const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
    sf = project.createSourceFile("__extension_probe__.contract.ts", contractSource, { overwrite: true });
  } catch {
    return ".ts";
  }
  for (const stmt of sf.getStatements()) {
    if (!isExportDecl(stmt)) continue;
    for (const ref of stmt.getDescendantsOfKind(SyntaxKind.TypeReference)) {
      if (names.has(ref.getTypeName().getText().trim())) return ".tsx";
    }
  }
  return ".ts";
}

/**
 * The fixed naming rule: foo.contract.ts is implemented by sibling foo.ts —
 * or foo.tsx when the contract declares a component and the source is on hand.
 *
 * The source stays OPTIONAL because two callers legitimately ask the path
 * question without it (surface-check pairs by existence; the path-only overload
 * is what the mapping test pins), and because `.ts` is the answer for every
 * contract that predates TSX.
 */
export function skeletonPathFor(
  contractPath: string,
  contractSource?: string,
  names: ReadonlySet<string> = new Set(),
): string {
  if (!contractPath.endsWith(CONTRACT_SUFFIX)) {
    throw new ScaffoldError(`scaffold: '${contractPath}' is not a *.contract.ts path`);
  }
  const ext = contractSource === undefined ? ".ts" : skeletonExtensionFor(contractSource, names);
  return contractPath.slice(0, -CONTRACT_SUFFIX.length) + ext;
}

/**
 * BOTH sibling paths a contract's implementation may legally occupy, `.ts`
 * first.
 *
 * The sync's two most destructive decisions — "is this already implemented?"
 * and "is this an orphan?" — must be asked about the PAIR, never about the one
 * path this run happens to want. A contract that grows a component would
 * otherwise write a fresh `.tsx` skeleton straight over the top of a finished
 * `.ts` implementation (or the reverse), which is r15's overwrite with a new
 * costume on: the file survives the non-clobber check only because the check
 * was looking at the other extension.
 */
export function skeletonSiblingPaths(contractPath: string): readonly string[] {
  const stem = skeletonPathFor(contractPath).slice(0, -".ts".length);
  return [`${stem}.ts`, `${stem}.tsx`];
}

/**
 * The header every generated file carries, as a pattern.
 *
 * This marker is the ONLY thing that makes a file provably machine-generated,
 * and the orphan sync below deletes nothing without it. A hand-written file
 * that merely happens to sit where a skeleton would sit — `src/orders/orders.ts`
 * written by someone before the contract existed — has no marker and survives.
 * Every pack generator emits it as line 1; the suite pins that, so they cannot
 * drift apart into "generated" files the sync no longer recognises and
 * therefore silently leaks.
 *
 * THE PACK SEGMENT IS A WILDCARD (TN-26-006 B1). It used to be the literal
 * `packs/ts/scripts/`, from the days when one pack owned every generator. The
 * ts-web pack's `new-web-app.ts` emits an FSD skeleton exactly as this file
 * emits a contract skeleton, and a marker the sync does not recognise is worse
 * than no marker at all: the file is undeletable by its own generator AND
 * indistinguishable from hand-written work. Widening the pack segment makes a
 * second pack's generator a first-class owner of its output — it may
 * byte-compare, overwrite and (when pruning arrives for it) delete, on exactly
 * the terms this one does.
 *
 * What stays NARROW is everything that matters: the literal `packs/`,
 * `/scripts/`, a lowercase pack name, a lowercase script name, and the exact
 * sentence. A project file cannot acquire the marker by accident, and a
 * generator outside a pack's scripts directory cannot claim it at all.
 */
const GENERATED_MARKER =
  /^\/\/ GENERATED from \S+ by packs\/[a-z][a-z0-9-]*\/scripts\/[a-z-]+\.ts — do not edit\.\s*$/;

/** Was this text written by a pack generator? Line 1 decides, and only line 1. */
export function isGeneratedArtifact(source: string): boolean {
  const firstNewline = source.indexOf("\n");
  return GENERATED_MARKER.test(firstNewline === -1 ? source : source.slice(0, firstNewline));
}

/** The generators whose output THIS sync owns, and may therefore delete. */
const OWN_GENERATORS = new Set([
  "packs/ts/scripts/scaffold-contract.ts",
  "packs/ts/scripts/value-object-laws.ts",
]);

const MARKER_GENERATOR = /^\/\/ GENERATED from \S+ by (\S+) — do not edit\./;

/**
 * Did one of THIS pack's generators write this file?
 *
 * The distinction did not exist while one pack owned every generator, and it
 * became load-bearing the moment a second one did (TN-26-006 B1): `new-web-app`
 * emits `src/ui/main.tsx`, which carries a marker, which this sync would
 * otherwise read as an orphaned skeleton and DELETE on the next design_gate —
 * a generator eating another pack's output because both spoke the same word.
 *
 * The marker names its generator, so the rule is simply that a generator
 * deletes only what it wrote. Every pack is an owner of its own tree and a
 * stranger to everyone else's.
 */
function isOwnArtifact(source: string): boolean {
  const firstNewline = source.indexOf("\n");
  const line = firstNewline === -1 ? source : source.slice(0, firstNewline);
  const named = MARKER_GENERATOR.exec(line)?.[1];
  return named !== undefined && OWN_GENERATORS.has(named);
}

// --- Contract support files (ADR 2026-046) ----------------------------------
//
// A contract can import a support module that is shipped machinery rather than
// business code (a service contract's "./service-runtime.js"). This scaffolder
// is the socket; the file, and the rule for where a contract asks for it, come
// from the composed pack that owns the capability (`contractSupportFiles`). A
// project that did not compose that pack gets nothing shipped.

/** The support files the project's composed packs contribute. */
export function contractSupportFor(cwd: string): readonly ContractSupportFile[] {
  return composedPacks(cwd).read(contractSupportFiles);
}

/** The canonical support file with the generated marker as line 1 —
 *  byte-identical on every emission, which lets the sync compare-and-skip. */
export function shippedSupportSource(file: ContractSupportFile): string {
  return `// GENERATED from ${file.canonical} by packs/ts/scripts/scaffold-contract.ts — do not edit.\n` + file.source();
}

/**
 * Delete generated files whose source contract is gone, and the directories
 * that leaves empty. Returns what it removed, project-relative and posix.
 *
 * `keep` is every artifact this run just generated, absolute. Anything else
 * carrying the marker was generated from a contract that no longer exists —
 * either deleted outright, or revised until it stopped producing that file
 * (a contract that loses its last value object loses its law suite).
 *
 * Why this belongs to the scaffolder and not to the person deleting the
 * contract: run r14 cost an architect ten minutes and two failed delegate
 * spawns trying to remove a scratch contract's leftovers, because generated
 * files live in write zones the architect does not hold. Deleting the contract
 * is the whole gesture; the generator owns its own output on the way back out
 * exactly as it owns it on the way in.
 */
function pruneOrphans(
  cwd: string,
  keep: ReadonlySet<string>,
): { readonly files: string[]; readonly dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  // `.tsx` is swept on exactly the same terms as `.ts` (TN-26-006 A1). A
  // skeleton the sync can write is a skeleton the sync must be able to take
  // back: an extension the walk cannot see is a generated file that leaks
  // forever once its contract goes. The marker still decides — this widens
  // what is LOOKED at, never what is deleted.
  for (const path of findFilesUnder(cwd, (name) => name.endsWith(".ts") || name.endsWith(".tsx"))) {
    if (keep.has(resolve(path))) continue;
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue; // vanished under us (a concurrent delete) — nothing to prune
    }
    // A generator deletes only what IT wrote — see isOwnArtifact.
    if (!isOwnArtifact(source)) continue;
    rmSync(path);
    files.push(relative(cwd, path).split(sep).join("/"));
    // Walk up while the pruning has emptied a directory, stopping at the
    // project root: `tests/generated/` with nothing left in it is debris too.
    let dir = dirname(path);
    while (resolve(dir) !== resolve(cwd) && existsSync(dir) && readdirSync(dir).length === 0) {
      rmdirSync(dir);
      dirs.push(relative(cwd, dir).split(sep).join("/"));
      dir = dirname(dir);
    }
  }
  return { files, dirs };
}

/** Template convention: the shared errors module lives at <root>/shared/errors,
 *  where root is the path up to and including the first 'src' segment. */
export function errorsModuleFor(contractPath: string): string {
  const segs = contractPath.replace(/\\/g, "/").split("/");
  const i = segs.indexOf("src");
  return (i >= 0 ? segs.slice(0, i + 1).join("/") + "/" : "") + "shared/errors";
}

function relativeSpecifier(fromFile: string, toModuleNoExt: string): string {
  const fromDir = posix.dirname(fromFile.replace(/\\/g, "/"));
  const rel = posix.relative(fromDir, toModuleNoExt + ".js");
  return rel.startsWith(".") ? rel : "./" + rel;
}

function fail(message: string): never {
  throw new ScaffoldError(`scaffold: ${message}`);
}

/** `./values.contract.js` → `./values.js`; anything that is not a contract
 *  module → undefined. Extension is preserved (NodeNext writes `.js`; a
 *  bare `./values.contract` keeps its bare form). */
export function implementationSpecifierFor(moduleSpecifier: string): string | undefined {
  const m = /^(.*)\.contract(\.[cm]?[jt]s)?$/.exec(moduleSpecifier);
  return m === null ? undefined : `${m[1]}${m[2] ?? ""}`;
}

// --- AST collection -----------------------------------------------------------

type ValueExport =
  | { kind: "function"; name: string; signatures: string[] } // verbatim "function name(…): T" texts
  | { kind: "const"; name: string; typeText: string }
  | { kind: "class"; name: string; head: string; members: ClassMemberOut[]; nominal: boolean };

/** 'line' members (declare fields, index signatures) join adjacent lines
 *  without a blank line; 'throwing' members get paragraph spacing. */
type ClassMemberOut =
  | { kind: "throwing"; sig: string; label: string; compact: false }
  | { kind: "line"; text: string; compact: boolean };

interface ContractInfo {
  values: ValueExport[];
  exportedTypes: string[]; // exported interface / type-alias names
  localTypes: string[]; // declared but not exported
  imports: { source: string; names: string[]; verbatim: string }[]; // type-only imports, source order
}

const RESERVED = new Set(["NotImplementedError", "notImplemented", "__Contract", "__conformance"]);

function isExportDecl(node: Node): boolean {
  return Node.isModifierable(node) && node.hasModifier(SyntaxKind.ExportKeyword);
}

/** Namespaces may hold types only; value members are unscaffoldable in v1. */
function namespaceHasValue(decl: Node & import("ts-morph").ModuleDeclaration): boolean {
  const body = decl.getBody();
  if (!body || !Node.isModuleBlock(body)) return false;
  return body.getStatements().some(
    (s) =>
      Node.isFunctionDeclaration(s) ||
      Node.isVariableStatement(s) ||
      Node.isClassDeclaration(s) ||
      Node.isEnumDeclaration(s) ||
      (Node.isModuleDeclaration(s) && namespaceHasValue(s)),
  );
}

/** Rebuild a function's signature text from parts (normalizes, never includes modifiers). */
function functionSignature(fn: FunctionDeclaration): string {
  const typeParams = fn.getTypeParameters();
  const tp = typeParams.length > 0 ? `<${typeParams.map((t) => t.getText()).join(", ")}>` : "";
  const params = fn.getParameters().map((p) => p.getText()).join(", ");
  const ret = fn.getReturnTypeNode()?.getText();
  return `function ${fn.getName() ?? ""}${tp}(${params})${ret ? `: ${ret}` : ""}`;
}

function memberNameText(member: NamedClassMember): string {
  const name = member.getNameNode();
  if (name === undefined) fail("anonymous class member in contract");
  if (Node.isIdentifier(name) || Node.isPrivateIdentifier(name)) return name.getText();
  if (Node.isStringLiteral(name)) return name.getLiteralValue();
  fail(`computed member name '${name.getText()}' is not scaffoldable`);
}

function renderClass(node: ClassDeclaration): ValueExport & { kind: "class" } {
  const name = node.getName()!;
  if (node.getExtends()) {
    // BACKSTOP: contract-purity's `value-object-shape` rule (classExtends) already
    // refuses an exported `declare class` with a superclass at the FIRST
    // design_gate step, with a reason; this fail() is the last line if purity is
    // bypassed (ADR 2026-027 — extends was already at purity).
    fail(`class '${name}' extends a base class — not scaffoldable in v1 (the throwing skeleton constructor cannot call super); model the error as data (a string-literal union or interface) or drop 'extends'`);
  }
  const ctors = node.getMembers().filter(Node.isConstructorDeclaration);
  if (ctors.length > 1) {
    fail(`overloaded constructor in '${name}' is not scaffoldable in v1 — use a single signature or a static factory`);
  }
  const methodCounts = new Map<string, number>();
  for (const m of node.getMembers()) {
    if (Node.isMethodDeclaration(m) && Node.isIdentifier(m.getNameNode())) {
      methodCounts.set(m.getName(), (methodCounts.get(m.getName()) ?? 0) + 1);
    }
  }
  for (const [n, c] of methodCounts) {
    if (c > 1) {
      fail(`overloaded method '${name}.${n}' is not scaffoldable in v1 — use distinct names or a discriminated input`);
    }
  }

  const typeParams = node.getTypeParameters();
  const tp = typeParams.length > 0 ? `<${typeParams.map((t) => t.getText()).join(", ")}>` : "";
  const heritage = node.getHeritageClauses();
  const head = `class ${name}${tp}${heritage.length > 0 ? " " + heritage.map((h) => h.getText()).join(" ") : ""}`;

  const members: ClassMemberOut[] = [];
  let nominal = false;

  for (const member of node.getMembers()) {
    const isPrivate =
      Node.isModifierable(member) &&
      (member.hasModifier(SyntaxKind.PrivateKeyword) || member.hasModifier(SyntaxKind.ProtectedKeyword));
    const isHashPrivate =
      "getNameNode" in member && member.getNameNode() !== undefined && Node.isPrivateIdentifier(member.getNameNode()!);
    if (isPrivate || isHashPrivate) nominal = true;

    if (Node.isConstructorDeclaration(member)) {
      const sig = member.getText().replace(/;\s*$/, "");
      members.push({ kind: "throwing", sig, label: `${name}.constructor`, compact: false });
      continue;
    }
    if (Node.isMethodDeclaration(member) || Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)) {
      const sig = member.getText().replace(/;\s*$/, "");
      members.push({ kind: "throwing", sig, label: `${name}.${memberNameText(member)}`, compact: false });
      continue;
    }
    if (Node.isPropertyDeclaration(member)) {
      const memberName = memberNameText(member);
      const typeNode = member.getTypeNode()?.getText();
      const typeText = typeNode ? `: ${typeNode}` : "";
      const isStatic = member.hasModifier(SyntaxKind.StaticKeyword);
      if (isHashPrivate) {
        // 'declare' is not allowed on # fields; an initializer is unreachable
        // (the constructor throws first) and satisfies strictPropertyInitialization.
        members.push({
          kind: "line",
          text: `${member.getNameNode()!.getText()}${typeText} = notImplemented("${name}.${memberName}");`,
          compact: false,
        });
        continue;
      }
      if (isStatic && !isPrivate) {
        // Public static property: reads must throw → emit as a throwing getter.
        members.push({
          kind: "throwing",
          sig: `static get ${memberName}()${typeText}`,
          label: `${name}.${memberName}`,
          compact: false,
        });
        continue;
      }
      // Instance (or private static) property: re-emit as a declare field.
      const mods = member
        .getModifiers()
        .filter((m) => m.getKind() !== SyntaxKind.ReadonlyKeyword && m.getKind() !== SyntaxKind.DeclareKeyword)
        .map((m) => m.getText());
      const readonly = member.hasModifier(SyntaxKind.ReadonlyKeyword) ? ["readonly"] : [];
      const optional = member.hasQuestionToken() ? "?" : "";
      members.push({
        kind: "line",
        text: `${[...mods, "declare", ...readonly].join(" ")} ${memberName}${optional}${typeText};`,
        compact: true,
      });
      continue;
    }
    if (Node.isIndexSignatureDeclaration(member)) {
      members.push({ kind: "line", text: `${member.getText()};`, compact: true });
      continue;
    }
    if (Node.isClassStaticBlockDeclaration(member)) {
      fail(`static block in '${name}' is not scaffoldable`);
    }
    fail(`unsupported class member '${(member as ClassMemberTypes).getKindName()}' in '${name}'`);
  }

  return { kind: "class", name, head, members, nominal };
}

function collect(sf: SourceFile): ContractInfo {
  const info: ContractInfo = { values: [], exportedTypes: [], localTypes: [], imports: [] };

  for (const stmt of sf.getStatements()) {
    if (Node.isImportDeclaration(stmt)) {
      const source = stmt.getModuleSpecifierValue();
      const clause = stmt.getImportClause();
      if (!clause) fail(`side-effect import '${source}' in contract — contracts declare shapes only`);
      else {
        const named: string[] = [];
        let typeOnly = clause.isTypeOnly();
        const namedBindings = clause.getNamedBindings();
        if (namedBindings && Node.isNamedImports(namedBindings)) {
          for (const el of namedBindings.getElements()) {
            if (!clause.isTypeOnly() && !el.isTypeOnly()) typeOnly = false;
            named.push(el.getName());
          }
        } else if (namedBindings) {
          if (!clause.isTypeOnly()) typeOnly = false; // namespace import
          named.push(namedBindings.getName());
        }
        const def = clause.getDefaultImport();
        if (def) {
          if (!clause.isTypeOnly()) typeOnly = false;
          named.push(def.getText());
        }
        if (!typeOnly) {
          fail(`value import '${source}' in contract — use 'import type' (declaration-only lint should have caught this)`);
        }
        // ONE IDENTITY PER VALUE OBJECT (ADR 2026-023). BACKSTOP: contract-purity's
        // `no-cross-contract-type-import` rule now catches this at the FIRST
        // design_gate step, and names the rule-id in the architect brief; this
        // fail() is the last line if purity is ever bypassed (ADR 2026-027).
        // Reaching into a sibling
        // CONTRACT picks up its ambient `declare class`, which is a second,
        // nominally distinct declaration of the same private `__brand` — so a
        // test that builds the value through the only legal route (the runtime
        // class in the implementation module) cannot pass it to any operation
        // declared this way. That is r15's 41-error unsatisfiable red, and no
        // amount of skeleton rewriting fixes it, because the contract's own
        // interfaces carry the wrong identity too. The implementation module
        // re-exports every type its contract declares, so the fix is total.
        const implSpecifier = implementationSpecifierFor(source);
        if (implSpecifier !== undefined) {
          const what = named.length > 0 ? named.slice().sort().join(", ") : "types";
          fail(
            `'${sf.getBaseName()}' imports { ${what} } from "${source}" — a contract's ambient ` +
              `declarations are a SECOND identity: a value object declared there is nominally distinct from ` +
              `the runtime class in that contract's implementation module, and TypeScript rejects every value ` +
              `built through the real class with "separate declarations of a private property '__brand'". ` +
              `There is exactly one identity per value object, so import the implementation module instead — ` +
              `it re-exports every type its contract declares: ` +
              `import type { ${what} } from "${implSpecifier}";`,
          );
        }
        info.imports.push({ source, names: named, verbatim: stmt.getText() });
      }
      continue;
    }
    if (Node.isImportEqualsDeclaration(stmt)) {
      if (!stmt.isTypeOnly()) fail("value import in contract — use 'import type'");
      continue;
    }
    if (Node.isFunctionDeclaration(stmt)) {
      if (stmt.hasBody()) fail(`function body in contract ('${stmt.getName() ?? "<default>"}') — contracts are declaration-only`);
      if (stmt.hasModifier(SyntaxKind.DefaultKeyword) || stmt.getName() === undefined) {
        fail("default export of a value is not scaffoldable — use a named export");
      }
      if (!isExportDecl(stmt)) continue;
      const sig = functionSignature(stmt);
      const existing = info.values.find((v) => v.kind === "function" && v.name === stmt.getName());
      if (existing && existing.kind === "function") existing.signatures.push(sig);
      else info.values.push({ kind: "function", name: stmt.getName()!, signatures: [sig] });
      continue;
    }
    if (Node.isVariableStatement(stmt)) {
      if (!stmt.hasModifier(SyntaxKind.DeclareKeyword)) {
        fail("value binding in contract — contracts are declaration-only (use 'export declare const X: …')");
      }
      if (!isExportDecl(stmt)) continue;
      collectConst(stmt, info);
      continue;
    }
    if (Node.isClassDeclaration(stmt)) {
      if (!stmt.hasModifier(SyntaxKind.DeclareKeyword)) {
        fail(`class '${stmt.getName() ?? "<anonymous>"}' has a runtime body — contracts use 'declare class'`);
      }
      if (stmt.hasModifier(SyntaxKind.DefaultKeyword) || stmt.getName() === undefined) {
        fail("default export of a value is not scaffoldable — use a named export");
      }
      if (isExportDecl(stmt)) info.values.push(renderClass(stmt));
      continue;
    }
    if (Node.isEnumDeclaration(stmt)) {
      // BACKSTOP: contract-purity's `declaration-only` rule (enumRuntime) already
      // refuses every enum at the FIRST design_gate step, with the same
      // "use a string-literal union" remedy; this fail() is the last line if
      // purity is bypassed (ADR 2026-027 — enum was already at purity).
      fail(`enum '${stmt.getName()}' is not scaffoldable — use a string-literal union type in the contract (TN-26-001)`);
    }
    if (Node.isModuleDeclaration(stmt)) {
      const isGlobal = stmt.getName() === "global";
      if (!isGlobal && namespaceHasValue(stmt)) {
        fail(`namespace '${stmt.getName()}' exports values — namespaces may hold types only; flatten values to top-level 'export declare'`);
      }
      continue;
    }
    if (Node.isInterfaceDeclaration(stmt) || Node.isTypeAliasDeclaration(stmt)) {
      (isExportDecl(stmt) ? info.exportedTypes : info.localTypes).push(stmt.getName());
      continue;
    }
    if (Node.isExportDeclaration(stmt)) {
      if (!stmt.isTypeOnly()) fail("value re-export in contract — use 'export type …'");
      // Re-exporting another contract's declarations launders the second
      // identity into this contract's surface, which is the same defect one
      // level of indirection further out. BACKSTOP: contract-purity's
      // `no-cross-contract-type-import` rule catches this re-export form first
      // (ADR 2026-027); this fail() is the last line if purity is bypassed.
      const from = stmt.getModuleSpecifierValue();
      const implSpecifier = from === undefined ? undefined : implementationSpecifierFor(from);
      if (from !== undefined && implSpecifier !== undefined) {
        fail(
          `'${sf.getBaseName()}' re-exports from "${from}" — a contract's ambient declarations are a ` +
            `SECOND identity for every value object they declare. Re-export the implementation module ` +
            `instead: export type … from "${implSpecifier}";`,
        );
      }
      continue;
    }
    if (Node.isExportAssignment(stmt)) fail("'export =' is CommonJS interop — use named exports");
    if (stmt.getKind() === SyntaxKind.EmptyStatement) continue;
    fail(`unsupported statement '${stmt.getKindName()}' in contract — contracts contain types and ambient declarations only`);
  }
  return info;
}

function collectConst(stmt: VariableStatement, info: ContractInfo): void {
  for (const d of stmt.getDeclarationList().getDeclarations()) {
    const nameNode = d.getNameNode();
    if (!Node.isIdentifier(nameNode)) {
      fail(`destructuring declare in contract ('${nameNode.getText()}') — declare one name per statement`);
    }
    const typeNode = d.getTypeNode();
    if (!typeNode) {
      fail(`declare const '${d.getName()}' needs an explicit type — inference has nothing to work with in a contract`);
    }
    info.values.push({ kind: "const", name: d.getName(), typeText: typeNode.getText() });
  }
}

// --- type-reference resolution (so verbatim signatures compile) ----------------

function leftmostName(node: Node): string {
  return Node.isQualifiedName(node) ? leftmostName(node.getLeft()) : node.getText();
}

function typeRefsOf(node: Node, exclude: Set<string>): Set<string> {
  const refs = new Set<string>();
  for (const ref of node.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    refs.add(leftmostName(ref.getTypeName() as Node));
  }
  for (const tq of node.getDescendantsOfKind(SyntaxKind.TypeQuery)) {
    refs.add(leftmostName(tq.getExprName()));
  }
  for (const e of exclude) refs.delete(e);
  for (const v of [...refs]) if (exclude.has(v)) refs.delete(v);
  return refs;
}

// --- rendering ------------------------------------------------------------------

/** What a contract actually exposes — the shape questions the gates need to ask. */
export interface ContractSurface {
  /** Exports that exist at RUNTIME: what can be implemented and called. */
  readonly valueExports: readonly string[];
  /** Methods declared on exported interfaces: operations that are types only. */
  readonly interfaceMethods: readonly string[];
}

/**
 * Summarise a contract's public surface without generating anything.
 *
 * Needed because "does this contract expose anything implementable?" cannot be
 * answered from the generated text — the skeleton's own header comment
 * mentions NotImplementedError, so a substring check always says yes. Ask the
 * AST instead.
 */
export function contractSurface(contractSource: string, contractFileName: string): ContractSurface {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sf = project.createSourceFile(basename(contractFileName), contractSource, { overwrite: true });
  const info = collect(sf);
  const interfaceMethods: string[] = [];
  for (const stmt of sf.getStatements()) {
    if (!Node.isInterfaceDeclaration(stmt) || !isExportDecl(stmt)) continue;
    for (const m of stmt.getMembers()) {
      if (Node.isMethodSignature(m)) interfaceMethods.push(`${stmt.getName()}.${m.getName()}`);
      // A property whose type is a function is an operation too.
      else if (Node.isPropertySignature(m)) {
        const t = m.getTypeNode();
        if (t && Node.isFunctionTypeNode(t)) interfaceMethods.push(`${stmt.getName()}.${m.getName()}`);
      }
    }
  }
  return { valueExports: info.values.map((v) => v.name), interfaceMethods };
}

export interface ScaffoldOptions {
  /** Project-relative path (no extension) of the shared errors module.
   *  Default: errorsModuleFor(contractFileName) → <root>/shared/errors. */
  readonly errorsModule?: string;
}

export function scaffoldContract(
  contractSource: string,
  contractFileName: string,
  options: ScaffoldOptions = {},
): string {
  const baseTs = basename(contractFileName);
  if (!baseTs.endsWith(CONTRACT_SUFFIX)) {
    throw new ScaffoldError(`scaffold: '${contractFileName}' is not a *.contract.ts path`);
  }
  const contractSpecifier = "./" + baseTs.replace(/\.ts$/, ".js");
  const errorsSpecifier = relativeSpecifier(
    contractFileName.replace(/\\/g, "/"),
    options.errorsModule ?? errorsModuleFor(contractFileName),
  );

  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile(baseTs, contractSource);
  const info = collect(sf);

  // Only value-exporting declarations are re-emitted, so only their type
  // references need resolving in the skeleton.
  const refs = new Set<string>();
  for (const stmt of sf.getStatements()) {
    if (Node.isFunctionDeclaration(stmt) && stmt.getName() && isExportDecl(stmt)) {
      for (const r of typeRefsOf(stmt, new Set(stmt.getTypeParameters().map((t) => t.getName())))) refs.add(r);
    } else if (Node.isVariableStatement(stmt) && isExportDecl(stmt)) {
      for (const r of typeRefsOf(stmt, new Set())) refs.add(r);
    } else if (Node.isClassDeclaration(stmt) && stmt.getName() && isExportDecl(stmt)) {
      const classTPs = new Set(stmt.getTypeParameters().map((t) => t.getName()));
      for (const h of stmt.getHeritageClauses()) for (const r of typeRefsOf(h, classTPs)) refs.add(r);
      for (const m of stmt.getMembers()) {
        const memberTPs =
          Node.isMethodDeclaration(m) || Node.isGetAccessorDeclaration(m) || Node.isSetAccessorDeclaration(m)
            ? m.getTypeParameters().map((t) => t.getName())
            : [];
        for (const r of typeRefsOf(m, new Set([...classTPs, ...memberTPs]))) refs.add(r);
      }
    }
  }

  for (const v of info.values) {
    if (RESERVED.has(v.name)) fail(`export '${v.name}' collides with scaffold internals — rename it in the contract`);
  }
  for (const t of info.exportedTypes) {
    if (RESERVED.has(t)) fail(`type '${t}' collides with scaffold internals — rename it in the contract`);
  }

  const unexported = [...refs].filter((r) => info.localTypes.includes(r));
  if (unexported.length > 0) {
    fail(`'${unexported[0]}' is part of the public surface but not exported — export it from the contract`);
  }

  const contractTypeImports = [...refs].filter((r) => info.exportedTypes.includes(r)).sort();
  const externalImports: string[] = [];
  for (const imp of info.imports) {
    const needed = imp.names.filter((n) => refs.has(n));
    if (needed.length === 0) continue;
    if (imp.verbatim.includes("*")) {
      externalImports.push(imp.verbatim); // namespace type import: re-emit whole
    } else {
      externalImports.push(`import type { ${[...needed].sort().join(", ")} } from "${imp.source}";`);
    }
  }

  const conformance = info.values.filter((v) => v.kind !== "class" || !v.nominal);
  const usesNotImplementedError = info.values.some((v) => v.kind !== "const");
  const usesNotImplemented = info.values.some(
    (v) =>
      v.kind === "const" ||
      (v.kind === "class" && v.members.some((m) => m.kind === "line" && m.text.includes("notImplemented("))),
  );

  // --- emit ---
  const w = new CodeBlockWriter({ newLine: "\n", indentNumberOfSpaces: 2, useSingleQuote: false, useTabs: false });

  w.writeLine(`// GENERATED from ${baseTs} by packs/ts/scripts/scaffold-contract.ts — do not edit.`);
  w.writeLine("// Red-phase skeleton (TN-26-001): every value export throws NotImplementedError.");
  w.writeLine("// The builder replaces this file with the real implementation.");
  w.blankLine();

  if (info.values.length > 0) {
    const errorNames = [
      usesNotImplementedError ? "NotImplementedError" : null,
      usesNotImplemented ? "notImplemented" : null,
    ].filter((n): n is string => n !== null);
    w.writeLine(`import { ${errorNames.join(", ")} } from "${errorsSpecifier}";`);
    for (const line of externalImports) w.writeLine(line);
    if (contractTypeImports.length > 0) {
      w.writeLine(`import type { ${contractTypeImports.join(", ")} } from "${contractSpecifier}";`);
    }
    if (conformance.length > 0) {
      w.writeLine(`import type * as __Contract from "${contractSpecifier}";`);
    }
    w.blankLine();
  }
  w.writeLine(`export type * from "${contractSpecifier}";`);

  for (const v of info.values) {
    w.blankLine();
    switch (v.kind) {
      case "function": {
        if (v.signatures.length === 1) {
          w.write(`export ${v.signatures[0]}`).block(() => {
            w.writeLine(`throw new NotImplementedError("${v.name}");`);
          });
        } else {
          for (const s of v.signatures) w.writeLine(`export ${s};`);
          w.write(`export function ${v.name}(..._args: unknown[]): unknown`).block(() => {
            w.writeLine(`throw new NotImplementedError("${v.name}");`);
          });
        }
        break;
      }
      case "const":
        w.writeLine(`export const ${v.name}: ${v.typeText} = notImplemented("${v.name}");`);
        break;
      case "class": {
        w.write(`export ${v.head}`).block(() => {
          v.members.forEach((m, i) => {
            const prev = v.members[i - 1];
            if (i > 0 && !(m.compact && prev?.compact)) w.blankLine();
            if (m.kind === "throwing") {
              w.write(m.sig).block(() => {
                w.writeLine(`throw new NotImplementedError("${m.label}");`);
              });
            } else {
              w.writeLine(m.text);
            }
          });
        });
        if (v.nominal) {
          w.blankLine();
          w.writeLine("// Conformance note: classes with private/protected members are nominal in TS,");
          w.writeLine("// so class conformance is by verbatim construction, not a typeof check.");
        }
        break;
      }
    }
  }

  if (conformance.length > 0) {
    // The annotation is Pick'd down to EXACTLY the names in the object literal,
    // never the whole `typeof __Contract`. A nominal value-object class cannot be
    // checked by a typeof comparison (ADR 2026-015: surface-check verifies it
    // semantically), so it is excluded from the object — but `typeof __Contract`
    // still includes it, and TS then raises TS2740 ("… is missing … BuildingId")
    // for a skeleton that mixes a nominal class with non-class value exports in
    // one file (dogfood r18). Pick lists the same names as the keys, so the check
    // asserts precisely those exports conform and demands nothing the object omits.
    const conformanceNames = conformance.map((v) => v.name);
    const pick = conformanceNames.map((n) => `"${n}"`).join(" | ");
    w.blankLine();
    w.writeLine("// Compile-time conformance: every scaffoldable value export of the contract");
    w.writeLine("// exists above, with the signature the contract declared.");
    w.writeLine(`const __conformance: Pick<typeof __Contract, ${pick}> = { ${conformanceNames.join(", ")} };`);
    w.writeLine("void __conformance;");
  }

  let text = w.toString();
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

// --- Runner (shared by the CLI and the scaffold step of `design_gate`) ----------

/**
 * Scaffold every contract under `cwd` (or just the given paths).
 *
 * The CLI takes ONE contract path per call, and that cost real time in dogfood
 * Run 4: the orchestrator passed it a glob, got a confusing error, and went
 * reading the script to work out why. `design_gate` passes no path at all — it
 * finds the contracts itself — so the footgun stops existing.
 *
 * Also fixes the ordering nit recorded in docs/dogfooding.md: the skeleton is
 * GENERATED (which is what rejects a bad contract) before anything is written,
 * so a rejected scaffold no longer leaves a stray shared errors module behind.
 *
 * This is a SYNC, not an append: on a complete pass it also PRUNES generated
 * files whose contract has gone (see pruneOrphans). The set of generated files
 * is a function of the set of contracts, and a step that only ever adds makes
 * that false the moment a contract is deleted.
 *
 * And the sync is NON-DESTRUCTIVE in both directions: it writes a skeleton
 * only over absence or over another skeleton, and it deletes only files
 * carrying the generated marker. Real work is never a casualty of re-running
 * a generator (ADR 2026-023).
 */
export function runScaffold(
  cwd: string,
  contractPaths?: readonly string[],
): { code: number; lines: readonly string[] } {
  const contracts = contractPaths ?? findContractFiles(cwd);
  if (contracts.length === 0) {
    const summary = "no *.contract.ts files found — nothing to scaffold";
    logGuardEvent(cwd, { guard: "scaffold", verdict: "error", summary });
    return { code: 2, lines: [`scaffold: ${summary}`] };
  }

  let names: ReadonlySet<string>;
  let supportFiles: readonly ContractSupportFile[];
  try {
    names = componentTypeNames(cwd);
    supportFiles = contractSupportFor(cwd);
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    logGuardEvent(cwd, { guard: "scaffold", verdict: "block", summary });
    return { code: 1, lines: [`scaffold: ${summary}`] };
  }
  const lines: string[] = [];
  const typesOnly: string[] = [];
  const strandedOps: string[] = [];
  let implementable = 0;
  // Every artifact this run generated, absolute — the other half of the SYNC.
  // Whatever carries the generated marker and is NOT in here has lost its
  // contract, and the prune at the end of a complete pass removes it.
  const generated = new Set<string>();

  for (const contractPath of contracts) {
    // Read ONCE. Every decision this iteration makes — what to generate, which
    // extension it lands on, whether it ships a runtime, whether it has laws —
    // must be taken over the same bytes, or a contract edited mid-run could be
    // scaffolded as one thing and named as another.
    const contractText = readFileSync(contractPath, "utf8");
    let skeleton: string;
    try {
      // Generate first: this is the step that rejects a bad contract, and it
      // touches nothing on disk.
      skeleton = scaffoldContract(contractText, contractPath);
    } catch (e) {
      if (!(e instanceof ScaffoldError)) throw e;
      logGuardEvent(cwd, {
        guard: "scaffold",
        verdict: "block",
        summary: e.message,
        detail: { contract: contractPath },
      });
      return { code: 1, lines: [...lines, e.message] };
    }

    // Does this contract expose anything that exists at RUNTIME? Ask the AST,
    // not the generated text — the skeleton's own header comment mentions
    // NotImplementedError, so a substring check always says yes.
    //
    // Dogfood Run 6: every operation was a method on `export interface
    // SubscriptionBilling`. Interfaces vanish at compile time, so there was no
    // way to obtain the thing under test — yet contract-purity, typecheck and
    // checksum-gate all passed on it. A types-only file is legitimate as shared
    // vocabulary, so decide once every contract has been seen rather than
    // blocking per file.
    const surface = contractSurface(contractText, contractPath);
    if (surface.valueExports.length === 0) {
      typesOnly.push(relative(cwd, contractPath).split(sep).join("/"));
      strandedOps.push(...surface.interfaceMethods);
    } else {
      implementable += 1;
    }

    const errorsPath = errorsModuleFor(contractPath) + ".ts";
    let createdErrorsModule = false;
    if (!existsSync(errorsPath)) {
      mkdirSync(dirname(errorsPath), { recursive: true });
      writeFileSync(errorsPath, ERRORS_MODULE_SOURCE);
      createdErrorsModule = true;
      lines.push(`scaffold: created ${errorsPath} (template shared errors module)`);
    }
    // Where this run WOULD write: `.tsx` when the contract declares a component
    // (TN-26-006 A1), `.ts` otherwise — decided from the contract's own text, so
    // the generated set stays a pure function of the contract set.
    const out = skeletonPathFor(contractPath, contractText, names);
    const outRel = relative(cwd, resolve(cwd, out)).split(sep).join("/");
    // NON-DESTRUCTIVE SYNC (ADR 2026-023). The scaffolder writes a skeleton
    // only where there is nothing to lose: the target is absent, or it is
    // itself a generated skeleton — the same marker, and the same licence,
    // that lets the prune below delete a file. Run r15 re-froze the contracts
    // mid-loop and the scaffold step overwrote finished implementations in
    // BOTH arms; one survived on a lucky `git add -A`, the other rebuilt 28
    // minutes of work. Nothing about re-running a generator should be able to
    // cost that.
    //
    // The question is asked of BOTH siblings, never only of `out`. A contract
    // that gains (or loses) a component changes which extension this run wants,
    // and an implementation sitting at the other one is still an implementation:
    // looking only where we intend to write would hand r15's overwrite a second
    // door, opened by an editing act — adding a `ReactNode` return — that reads
    // as entirely innocent.
    //
    // Skipping does not hide contract drift: the kept implementation is checked
    // against the new contract by design_gate's typecheck step and by green's
    // surface check, and both route the resulting errors to the builder — who
    // is the only role that can reconcile them anyway.
    const implemented = skeletonSiblingPaths(contractPath).find((sibling) => {
      const text = existsSync(sibling) ? readFileSync(sibling, "utf8") : undefined;
      return text !== undefined && !isGeneratedArtifact(text);
    });
    if (implemented !== undefined) {
      // Keep it out of the prune's sights too: "keep" is one decision, not two.
      // Note it is the IMPLEMENTED path that is kept, which may not be the one
      // this run wanted — the point of asking both.
      const keptRel = relative(cwd, resolve(cwd, implemented)).split(sep).join("/");
      generated.add(resolve(cwd, implemented));
      const kept = `scaffold: kept ${keptRel} — implemented; contract drift will surface as type errors routed to the builder`;
      lines.push(kept);
      logGuardEvent(cwd, {
        guard: "scaffold",
        verdict: "pass",
        summary: `kept ${keptRel} (implemented)`,
        detail: { contract: contractPath, skeleton: keptRel, kept: true, createdErrorsModule },
      });
    } else {
      writeFileSync(out, skeleton);
      generated.add(resolve(cwd, out));
      lines.push(`scaffold: wrote ${outRel}`);
      logGuardEvent(cwd, {
        guard: "scaffold",
        verdict: "pass",
        summary: `wrote ${outRel}`,
        detail: { contract: contractPath, skeleton: outRel, createdErrorsModule },
      });
      // A skeleton at the OTHER extension is now stale — the contract changed
      // its mind about being a component. It carries the marker and is absent
      // from `generated`, so the prune below removes it and says so; nothing
      // special-cases it here, which is exactly the point of having one sync.
    }

    // --- Contract support files (TN-26-004, ADR 2026-046) ------------------
    //
    // A contract that imports a composed pack's support module (a service
    // contract's "./service-runtime.js") has the canonical file SHIPPED, never
    // written: copied to the resolved path with a GENERATED marker — the
    // surface-check rule again, ONE implementation copied verbatim. In
    // `generated`, so a contract that stops asking loses its copy in the same
    // sync that removes any other orphan. A file already at that path WITHOUT
    // the marker is a block, not a keep: this file is machinery, and a
    // hand-written twin is exactly the fork the one-implementation rule exists
    // to prevent.
    for (const support of supportFiles) {
      // Targets come from a contributed function reading the contract's own
      // imports, so each is held to the project's src/ before any write.
      const asked = containedSupportTargets(support, contractText, contractPath, cwd);
      if (!asked.ok) {
        logGuardEvent(cwd, { guard: "scaffold", verdict: "block", summary: asked.reason, detail: { contract: contractPath } });
        return { code: 1, lines: [...lines, `scaffold: BLOCK — ${asked.reason}`] };
      }
      for (const rtAbs of asked.targets) {
        const rtRel = relative(cwd, rtAbs).split(sep).join("/");
        const shipped = shippedSupportSource(support);
        const current = existsSync(rtAbs) ? readFileSync(rtAbs, "utf8") : undefined;
        if (current !== undefined && !isGeneratedArtifact(current)) {
          const summary =
            `${rtRel} exists but does not carry the generated marker — the ${support.label} is shipped ` +
            "machinery (one implementation, copied verbatim), never hand-written; move the file aside and re-run";
          logGuardEvent(cwd, { guard: "scaffold", verdict: "block", summary, detail: { contract: contractPath } });
          return { code: 1, lines: [...lines, `scaffold: BLOCK — ${summary}`] };
        }
        if (current !== shipped) {
          mkdirSync(dirname(rtAbs), { recursive: true });
          writeFileSync(rtAbs, shipped);
          lines.push(`scaffold: wrote ${rtRel} (${support.label}, shipped verbatim from the pack)`);
          logGuardEvent(cwd, {
            guard: "scaffold",
            verdict: "pass",
            summary: `wrote ${rtRel}`,
            detail: { contract: contractPath, runtime: rtRel },
          });
        }
        generated.add(rtAbs);
      }
    }

    // The value-object law suite is generated from the same frozen contract, in
    // the same breath, for the same reason the skeleton is: nobody hand-writes
    // it, so nobody can forget it. Run 7's suite tested 6 of 15 exports and
    // never touched a single parser.
    //
    // Blindness is untouched — the laws are derived from the CONTRACT, never
    // from the tests, exactly like the skeleton. And a contract with no value
    // objects simply has no laws to state, which is not an error.
    const contractRel = relative(cwd, contractPath).split(sep).join("/");
    // A contract with no value objects simply has no laws to state; anything
    // else that goes wrong here is a real error and must be said out loud. An
    // exception used as control flow would have hidden a genuine failure behind
    // "nothing to generate" — which is how a gate stops being a gate.
    if (valueObjectsOf(contractText, contractRel).length > 0) {
      const lawsRel = lawsPathFor(contractRel);
      const lawsPath = join(cwd, lawsRel);
      let laws: string;
      try {
        laws = valueObjectLawsSource(contractText, contractRel);
      } catch (e) {
        if (!(e instanceof ValueObjectLawsError)) throw e;
        logGuardEvent(cwd, {
          guard: "scaffold",
          verdict: "block",
          summary: e.message,
          detail: { contract: contractRel },
        });
        return { code: 1, lines: [...lines, e.message] };
      }
      mkdirSync(dirname(lawsPath), { recursive: true });
      writeFileSync(lawsPath, laws);
      generated.add(resolve(cwd, lawsPath));
      lines.push(`scaffold: wrote ${lawsRel} (value-object laws)`);
      logGuardEvent(cwd, {
        guard: "scaffold",
        verdict: "pass",
        summary: `wrote ${lawsRel}`,
        detail: { contract: contractRel, laws: lawsRel },
      });
    }
    // A contract that has lost its last value object simply generates no laws
    // file this run, so it is not in `generated` — the sync below removes the
    // stale suite for exactly the same reason it removes a deleted contract's,
    // and says so, where the old bespoke unlink was silent.
  }

  if (implementable === 0) {
    const summary = `no contract declares anything to implement (${typesOnly.join(", ")})`;
    logGuardEvent(cwd, {
      guard: "scaffold",
      verdict: "block",
      summary,
      detail: { typesOnly, strandedOps },
    });

    // The message must NOT read as "add a value export", because the cheapest
    // way to satisfy that is one god-function — which would make the design
    // worse, not better. Name the operations already declared and ask for those
    // exact ones, so the fix preserves the shape the architect chose.
    const how =
      strandedOps.length > 0
        ? [
            `  You already declared ${strandedOps.length} operation${strandedOps.length === 1 ? "" : "s"}: ${strandedOps.join(", ")}.`,
            "  Keep that shape — do not collapse them into one entry point. Either export each",
            "  operation as its own declaration:",
            ...strandedOps.slice(0, 3).map((op) => `    export declare function ${op.split(".")[1]}(…): …;`),
            "  or export a factory that returns the interface:",
            `    export declare function create${strandedOps[0]?.split(".")[0] ?? "Service"}(deps: Deps): ${strandedOps[0]?.split(".")[0] ?? "Service"};`,
          ]
        : [
            "  Declare the operations this component provides, one per behaviour:",
            "    export declare function doThing(input: In): Out;",
          ];

    return {
      code: 1,
      lines: [
        ...lines,
        `scaffold: BLOCK — ${typesOnly.join(", ")} declares only types, so there is nothing to implement.`,
        "  An `export interface Foo { bar(): Baz }` is a TYPE: it does not exist at runtime, so",
        "  neither the test-writer nor the builder can obtain a Foo to work with.",
        ...how,
      ],
    };
  }

  // --- SYNC: generated files whose contract is gone ---------------------------
  //
  // Only on a COMPLETE pass. A run that blocked part-way through returned
  // above with `generated` half-filled, and pruning against a half-filled
  // keep-set would delete the artifacts of contracts this run never reached.
  // "Nothing was removed" is always the safe answer to a scaffold that failed.
  const pruned = pruneOrphans(cwd, generated);
  for (const file of pruned.files) lines.push(`scaffold: pruned ${file} — its contract no longer exists`);
  for (const dir of pruned.dirs) lines.push(`scaffold: removed empty directory ${dir}`);
  if (pruned.files.length > 0) {
    logGuardEvent(cwd, {
      guard: "scaffold",
      verdict: "pass",
      summary: `pruned ${pruned.files.length} orphaned generated file${pruned.files.length === 1 ? "" : "s"}`,
      detail: { pruned: pruned.files, removedDirs: pruned.dirs },
    });
  }
  return { code: 0, lines };
}

// --- CLI ------------------------------------------------------------------------

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
  // A thin wrapper over runScaffold, like every other gate's CLI. It used to be
  // a second implementation, and it had drifted: it wrote the shared errors
  // module BEFORE validating the path (so a mistyped argument left a stray file
  // behind) and never generated the value-object laws. "The tool and the CLI
  // must run the same gate" is worth nothing when they are two code paths.
  const arg = process.argv[2];
  const cwd = arg === undefined ? process.cwd() : arg.endsWith(CONTRACT_SUFFIX) ? dirname(arg) : arg;
  const contracts = arg !== undefined && arg.endsWith(CONTRACT_SUFFIX) ? [arg] : undefined;
  const { code, lines } = runScaffold(arg !== undefined && arg.endsWith(CONTRACT_SUFFIX) ? process.cwd() : cwd, contracts);
  // Failures go to stderr, as they always have: a scaffold that refused is an
  // error, and a caller redirecting stdout should still see why.
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  process.exit(code);
}
