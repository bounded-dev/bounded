import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-001 architect zone rule (issue #3): value objects over primitives on a
// contract's PUBLIC surface. The `declaration-only` rule checks a contract is
// well-formed; this one checks it says something. Dogfood evidence
// (docs/dogfooding.md, runs 1-3): Haiku shipped `isbn: string`,
// `pagesRead: number`, `authors: string[]` where Sonnet shipped `Isbn`,
// `PagesRead`, `AuthorName` — structurally identical, semantically empty, and
// every gate passed. The preference lived in prose (ts-contract-authoring
// says "value objects over primitives"); prose is not a harness layer.
//
// Error messages are written for an agent reader, not a human (TN appendix,
// Kinney: "write lint error messages like prompts"): each names the sin AND
// the exact declaration to write instead.
//
// --- SCOPE (the precision IS the deliverable) ---------------------------------
//
// A rule that fires on correct designs gets switched off, so the exemptions
// below are deliberate, not gaps:
//
// * Only `string` and `number` in slots (plus bare built-in aliases, below).
//   **`boolean` is out of scope**: a branded
//   boolean (`Bool<"Active">`) carries no more information than the property
//   name, and the real fix for a boolean smell is a state union
//   ("active" | "archived") — a domain judgement the linter cannot make
//   deterministically. Flagging every flag would be pure noise. This rule is a
//   floor, not a design review.
// * Only the **public boundary**: exported interfaces, exported type aliases,
//   `export declare function/const`, and ambient namespace members. Unexported
//   types are internal (and the scaffolder already forces any type on the
//   public surface to be exported, so there is no back door).
// * **Intersections are never entered.** `string & { readonly __brand: "Isbn" }`
//   is the base of a value object, not a naked primitive — and the rule stays
//   agnostic about which branding convention (`__brand`, `_tag`, unique symbol)
//   the project uses.
// * **Literal and template-literal types are already value objects.**
//   `"open" | "paid"` is the enum replacement the declaration-only rule
//   mandates; `` `${string}-${number}` `` is a constrained pattern.
// * `void`, `never`, `unknown`, `symbol`, `bigint`, `null`, `undefined` are not
//   domain values, so `Promise<void>` and friends are silent.
// * **Type parameters and their constraints are the caller's choice** — never
//   walked. Nor are type arguments in general: only the transparent containers
//   below are looked through, because for anything else (`Result<string, E>`)
//   the primitive belongs to that type's author, not this contract's.
// * **Index-signature keys and Record/Map key positions are exempt**: an index
//   domain, and TS permits nothing but string/number/symbol there anyway.
// * **A concept's own wire form is exempt** (ADR LEG-2026-059). In an interface
//   carrying a literal `__brand`, the `value` field and the `toJSON()` return
//   ARE the primitive the brand wraps — naming them with another value object
//   would be circular. Every other member of that interface is still walked.
//   `value-object-shape` and `entity-shape` hold the rest of those members'
//   shape; the pair is complete only together.
// * **A wire input is exempt** (ADR LEG-2026-059, TN-26-012 §3): `<X>Input` is
//   what callers send, so it is primitives by definition — but only when this
//   file also declares its branded twin `<X>Command`, the same fields as value
//   objects. Without the twin, `<X>Input` is an ordinary DTO and is checked.
// * **Classes are not walked.** `declaration-only` refuses every class in a
//   contract (the retired `declare class` form), so there is nothing here to
//   exempt or to check.
// * **Ports are treated exactly like DTOs** — no name or shape heuristic
//   ("…Store", "…Port", methods-only) distinguishes them. Deliberate: the
//   point of a port is that it is domain-facing (`save(id: Isbn)`), infra-
//   facing only in its implementation, so the domain vocabulary must cross it.
//   A heuristic here would make the rule unpredictable, and an agent cannot
//   comply with a rule it cannot predict.
//
// --- Bare aliases: naked in the same sense (issue #10, issue #13) --------------
//
// "Naked" is not only `string`/`number`. An exported alias whose right-hand
// side is a bare built-in object type is naked in exactly the same sense —
// assignable from every other value of that shape, carrying no invariant:
//
//   export type CalendarDate = Date;   // "always UTC midnight" — in a comment
//
// That is dogfood Run 4's real defect, and it is worse than any naked string
// in the same contract: `Date` is MUTABLE, so a caller who keeps a reference
// can rewrite a stored value after it was validated (probed: a billing period
// mutated into one that ends before it starts). It also slips past every
// downstream check — no class is declared, so value-object-shape stays
// silent, no law suite is generated, and the boundaries obligation never
// fires. Same disarming pattern ADR LEG-2026-015 records for the optional brand.
//
// So the alias branch (`primitiveAlias`) has a sibling (`builtinAlias`): at
// the TOP LEVEL of an exported alias's right-hand side, a reference to a
// built-in object type is reported. Deliberate boundaries:
//
// * **Alias position only.** `expiresAt: Date` on an interface is untouched.
//   Whether a `Date`-typed field is a defect is a design judgement (and the
//   mutation hazard is a different argument); the alias is not a judgement —
//   it claims to be a named domain type and nominally is not one.
// * **Both array spellings.** `Array<T>` and `T[]`/`readonly T[]` report the
//   same way at alias top level. An agent cannot comply with a rule whose
//   verdict depends on which spelling it chose.
// * **Additive.** The report does not stop the walk, so
//   `export type Tags = string[]` still also reports its naked element.
// * The set is closed and listed below rather than "any global": the rule is
//   syntactic, and guessing at unknown names would flag a project's own types.
//
// --- The parse boundary (the escape hatch) ------------------------------------
//
// A value object needs somewhere for a raw primitive to become one, and that
// somewhere is a function that RETURNS the value object:
//
//   export type Isbn = string & { readonly __brand: "Isbn" };
//   export declare function parseIsbn(raw: string): Isbn;   // not flagged
//
// So: naked primitives in a signature's PARAMETERS are exempt when the
// signature returns a value object declared in this contract (a branded alias
// or a literal union), unwrapping Promise and `| undefined`. The return
// position itself is never exempt. This is deliberately the rule's only way
// out — it channels every primitive in the design to one named, testable
// place instead of suppressing the complaint.
//
// Known limit, accepted: the value object must be declared in THIS file. The
// rule is syntactic (no type information), so it cannot see through an import
// to tell a branded alias from a DTO — and exempting every imported return
// type would gut the rule. The fix reads as good advice anyway: a brand and
// its only legal constructor belong in the same contract.
//
// --- NOT in scope: cardinality ------------------------------------------------
//
// The dogfood evidence pairs two defects in `authors: string[]`: the element is
// a naked string (this rule's business, one level down — hence the separate
// `nakedPrimitiveElement` message), and the array silently permits empty, so
// the "one or more authors" requirement is lost. Non-emptiness is a SEPARATE
// concern and undecidable from the contract alone — the rule cannot know
// whether empty is legal, and demanding `readonly [T, ...T[]]` everywhere
// would be wrong. So it is not enforced; the element message carries the
// prompt instead, where the architect is already reading.

type MessageId = "nakedPrimitive" | "nakedPrimitiveElement" | "primitiveAlias" | "builtinAlias";

type Primitive = "string" | "number";

const VALUE_OBJECTS =
  "Value objects over primitives on the contract's public surface (TN-26-001): a naked 'string'/'number' carries no domain meaning and no invariant — nothing stops an ISBN being passed where a title is expected.";

// The prescribed form is the contract-owns-the-name pair (ADR LEG-2026-059) — a
// branded alias would be bounced by `no-branded-aliases` in the same gate run.
const BRAND =
  'a {{brand}} value object in its own contract, {{stem}}.contract.ts: export interface {{brand}} { readonly __brand: "{{brand}}"; readonly value: {{primitive}}; equals(other: {{brand}}): boolean; toJSON(): {{primitive}}; } export interface {{brand}}Factory { parse(raw: unknown): Result<{{brand}}>; }';

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** Transparent containers: the wrapped type is still the domain value, so a
 *  naked primitive inside one is the same defect one level down. Anything not
 *  listed here is opaque — its type arguments belong to its own author. */
const TRANSPARENT = new Set(["Promise", "Awaited", "Readonly", "Required", "NonNullable"]);
/** Collections: same, but the primitive is an *element*, which gets the
 *  cardinality prompt as well. */
const COLLECTION = new Set(["Array", "ReadonlyArray", "Set", "ReadonlySet"]);
/** Keyed collections: the key is an index domain (exempt, as index signatures
 *  are); the value slot is a domain slot like any other. */
const KEYED = new Set(["Record", "Map", "ReadonlyMap", "WeakMap"]);
/** Built-in object types a contract may not hide a domain name behind. Closed
 *  on purpose: everything here is either a value carrier with no nominality
 *  (`Date`, `RegExp`) or a container that belongs at its use site rather than
 *  behind a domain name (`Map`, `Set`, `Array`, `Promise`). A project's own
 *  types are never guessed at. */
const BUILTIN_OBJECTS = new Set([
  "Date",
  "RegExp",
  "Array",
  "ReadonlyArray",
  "Set",
  "ReadonlySet",
  "Map",
  "ReadonlyMap",
  "WeakSet",
  "WeakMap",
  "Promise",
]);
/** Of those, the ones a caller can mutate through a retained reference — the
 *  extra tooth in the message, and dogfood Run 4's actual production bug. */
const MUTABLE_BUILTINS = new Set(["Date", "RegExp", "Array", "Set", "Map", "WeakSet", "WeakMap"]);

const PRIMITIVE_OF: Partial<Record<TSESTree.AST_NODE_TYPES, Primitive>> = {
  [TSESTree.AST_NODE_TYPES.TSStringKeyword]: "string",
  [TSESTree.AST_NODE_TYPES.TSNumberKeyword]: "number",
};

/** PascalCase a member/parameter name for the suggested brand: isbn → Isbn,
 *  pagesRead → PagesRead, DEFAULT_CURRENCY → DefaultCurrency. */
function pascalCase(name: string): string {
  const segments = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s.length > 0);
  if (segments.length === 0) return "Value";
  return segments.map((s) => s[0]!.toUpperCase() + s.slice(1).toLowerCase()).join("");
}

/** Element brands read better singular: authors → Author, entries → Entry.
 *  Deterministic and deliberately naive — it is a suggestion, not a rename. */
function singularize(word: string): string {
  if (/ies$/.test(word) && word.length > 3) return word.slice(0, -3) + "y";
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

interface Ctx {
  /** Nearest naming position — property, parameter, or declaration name. */
  readonly name: string;
  /** Inside a collection element / keyed-collection value slot. */
  readonly element: boolean;
  /** Set while still at the top level of an exported type alias's RHS: a
   *  primitive reached here is an unbranded alias, a different message. */
  readonly aliasName?: string;
}

export const noNakedPrimitives = createRule<[], MessageId>({
  name: "no-naked-primitives",
  meta: {
    type: "problem",
    messages: {
      nakedPrimitive: `${VALUE_OBJECTS} '{{name}}' is declared as '{{primitive}}' — declare ${BRAND} Then import it here with 'import type { {{brand}} } from "./{{stem}}.contract.ts";' and use it. Validation and parsing belong in the implementation; the contract just names the type.`,
      nakedPrimitiveElement: `${VALUE_OBJECTS} '{{name}}' is a collection of naked '{{primitive}}' — declare ${BRAND} Then use {{brand}}[] here. If the field means one-or-more, encode that too: 'readonly [{{brand}}, ...{{brand}}[]]' — an array type silently permits empty, and a requirement no type carries is a requirement nothing checks.`,
      builtinAlias: `'export type {{name}} = {{builtin}}' aliases a built-in object type — a name, not a value object: it is assignable from every other '{{builtin}}' in the program, so '{{name}}' carries no invariant, and because no concept is declared the value-object shape check and the generated laws all stay silent. {{teeth}} Delete the alias and declare a value object in its own contract (ADR LEG-2026-059): export interface {{name}} { readonly __brand: "{{name}}"; readonly value: string; equals(other: {{name}}): boolean; toJSON(): string; } plus export interface {{name}}Factory { parse(raw: unknown): Result<{{name}}>; } — choose what 'value' stores yourself (an ISO-8601 string is immutable; a Date is not). If '{{name}}' only names a container, delete the alias and write the container at its use sites instead.`,
      primitiveAlias: `${VALUE_OBJECTS} 'export type {{name}} = {{primitive}}' is an alias, not a value object — it is assignable from every other '{{primitive}}' in the program, so it buys nothing. Declare the value object in its own contract (ADR LEG-2026-059): export interface {{name}} { readonly __brand: "{{name}}"; readonly value: {{primitive}}; equals(other: {{name}}): boolean; toJSON(): {{primitive}}; } plus export interface {{name}}Factory { parse(raw: unknown): Result<{{name}}>; }`,
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function report(node: TSESTree.Node, primitive: Primitive, ctx: Ctx): void {
      if (ctx.aliasName !== undefined) {
        context.report({
          node,
          messageId: "primitiveAlias",
          data: { name: ctx.aliasName, primitive },
        });
        return;
      }
      const base = pascalCase(ctx.name);
      const brand = ctx.element ? singularize(base) : base;
      context.report({
        node,
        messageId: ctx.element ? "nakedPrimitiveElement" : "nakedPrimitive",
        data: {
          name: ctx.name,
          brand,
          stem: brand.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
          primitive,
        },
      });
    }

    /** The built-in behind an alias's right-hand side, if any. Both array
     *  spellings answer "Array" so the verdict cannot depend on which one the
     *  architect typed. */
    function builtinObjectOf(node: TSESTree.TypeNode): string | undefined {
      if (node.type === TSESTree.AST_NODE_TYPES.TSArrayType) return "Array";
      if (node.type !== TSESTree.AST_NODE_TYPES.TSTypeReference) return undefined;
      if (node.typeName.type !== TSESTree.AST_NODE_TYPES.Identifier) return undefined;
      return BUILTIN_OBJECTS.has(node.typeName.name) ? node.typeName.name : undefined;
    }

    function reportBuiltinAlias(node: TSESTree.Node, builtin: string, aliasName: string): void {
      context.report({
        node,
        messageId: "builtinAlias",
        data: {
          name: aliasName,
          builtin,
          teeth: MUTABLE_BUILTINS.has(builtin)
            ? `'${builtin}' is also mutable, so a caller who kept a reference can rewrite the value after it was validated (dogfood Run 4: a stored billing period was mutated into one that ends before it starts).`
            : `A container is not a domain type: nothing distinguishes '${aliasName}' from any other '${builtin}' with the same contents.`,
        },
      });
    }

    // --- value objects declared in this contract --------------------------------

    /** Names of local type aliases that ARE value objects: a primitive-based
     *  brand (`string & { … }`) or a literal union (`"open" | "paid"`). */
    const valueObjects = new Set<string>();

    function isValueObjectDefinition(node: TSESTree.TypeNode): boolean {
      switch (node.type) {
        case TSESTree.AST_NODE_TYPES.TSIntersectionType:
          // A brand: a primitive base intersected with a marker object.
          return node.types.some((t) => PRIMITIVE_OF[t.type] !== undefined);
        case TSESTree.AST_NODE_TYPES.TSUnionType:
          return node.types.every(
            (t) => t.type === TSESTree.AST_NODE_TYPES.TSLiteralType,
          );
        case TSESTree.AST_NODE_TYPES.TSLiteralType:
        case TSESTree.AST_NODE_TYPES.TSTemplateLiteralType:
          return true;
        default:
          return false;
      }
    }

    /** Does this return type hand back a value object declared here? Unwraps
     *  Promise/Awaited and `| undefined` — the two shapes a parse takes. */
    function returnsValueObject(node: TSESTree.TypeNode | undefined): boolean {
      if (!node) return false;
      switch (node.type) {
        case TSESTree.AST_NODE_TYPES.TSTypeReference: {
          const name =
            node.typeName.type === TSESTree.AST_NODE_TYPES.Identifier ? node.typeName.name : "";
          if (valueObjects.has(name)) return true;
          if (!TRANSPARENT.has(name)) return false;
          return (node.typeArguments?.params ?? []).some(returnsValueObject);
        }
        case TSESTree.AST_NODE_TYPES.TSUnionType:
          return node.types.some(returnsValueObject);
        // An inline literal union is a value object without needing a name.
        case TSESTree.AST_NODE_TYPES.TSLiteralType:
          return true;
        default:
          return false;
      }
    }

    // --- type walking ---------------------------------------------------------

    function walkType(node: TSESTree.TypeNode | undefined, ctx: Ctx): void {
      if (!node) return;
      const primitive = PRIMITIVE_OF[node.type];
      if (primitive) {
        report(node, primitive, ctx);
        return;
      }

      // A bare built-in at the top level of an exported alias's RHS: naked in
      // the same sense as a bare `string`, and the report is additive — the
      // walk continues, so a naked element inside still gets its own message.
      if (ctx.aliasName !== undefined) {
        const builtin = builtinObjectOf(node);
        if (builtin !== undefined) reportBuiltinAlias(node, builtin, ctx.aliasName);
      }

      const inner: Ctx = { ...ctx, aliasName: undefined };

      switch (node.type) {
        // A union is still the same slot: `string | undefined` is naked, and an
        // alias to a union of primitives is still an alias.
        case TSESTree.AST_NODE_TYPES.TSUnionType:
          for (const t of node.types) walkType(t, ctx);
          return;

        // Brand construct: `string & { readonly __brand: "Isbn" }`. Never
        // entered — this is what a correct answer looks like.
        case TSESTree.AST_NODE_TYPES.TSIntersectionType:
          return;

        case TSESTree.AST_NODE_TYPES.TSArrayType:
          walkType(node.elementType, { ...inner, element: true });
          return;

        case TSESTree.AST_NODE_TYPES.TSTupleType:
          for (const t of node.elementTypes) walkType(t, { ...inner, element: true });
          return;

        case TSESTree.AST_NODE_TYPES.TSRestType:
        case TSESTree.AST_NODE_TYPES.TSOptionalType:
          walkType(node.typeAnnotation, ctx);
          return;

        case TSESTree.AST_NODE_TYPES.TSNamedTupleMember:
          walkType(node.elementType, ctx);
          return;

        case TSESTree.AST_NODE_TYPES.TSTypeOperator:
          // `readonly T[]` is transparent; `keyof`/`unique` are not domain slots.
          if (node.operator === "readonly") walkType(node.typeAnnotation, ctx);
          return;

        case TSESTree.AST_NODE_TYPES.TSTypeReference: {
          const args = node.typeArguments?.params ?? [];
          if (args.length === 0) return;
          const name =
            node.typeName.type === TSESTree.AST_NODE_TYPES.Identifier ? node.typeName.name : "";
          if (TRANSPARENT.has(name)) {
            for (const a of args) walkType(a, inner);
          } else if (COLLECTION.has(name)) {
            for (const a of args) walkType(a, { ...inner, element: true });
          } else if (KEYED.has(name)) {
            // Key slot exempt (index domain); value slot checked.
            walkType(args[1], { ...inner, element: true });
          }
          // Anything else is opaque: its type arguments are its author's business.
          return;
        }

        case TSESTree.AST_NODE_TYPES.TSTypeLiteral:
          for (const member of node.members) walkMember(member);
          return;

        case TSESTree.AST_NODE_TYPES.TSMappedType:
          // The key is a type parameter; the value is a domain slot.
          walkType(node.typeAnnotation, inner);
          return;

        case TSESTree.AST_NODE_TYPES.TSFunctionType:
        case TSESTree.AST_NODE_TYPES.TSConstructorType:
          walkSignature(node, ctx.name);
          return;

        // Literals, template literals, conditional/indexed-access/infer types,
        // typeof queries, and every remaining keyword: not naked primitives.
        default:
          return;
      }
    }

    /** Parameters + return type of any callable form. */
    function walkSignature(
      node:
        | TSESTree.TSFunctionType
        | TSESTree.TSConstructorType
        | TSESTree.TSMethodSignature
        | TSESTree.TSCallSignatureDeclaration
        | TSESTree.TSConstructSignatureDeclaration
        | TSESTree.TSDeclareFunction
        | TSESTree.FunctionDeclaration,
      ownName: string,
    ): void {
      // The parse boundary: a signature that returns a value object declared
      // in this contract is where raw primitives are supposed to enter.
      if (!returnsValueObject(node.returnType?.typeAnnotation)) {
        for (const param of node.params) walkParam(param);
      }
      walkType(node.returnType?.typeAnnotation, { name: ownName, element: false });
    }

    function walkParam(param: TSESTree.Parameter): void {
      switch (param.type) {
        case TSESTree.AST_NODE_TYPES.Identifier:
          walkType(param.typeAnnotation?.typeAnnotation, { name: param.name, element: false });
          return;
        case TSESTree.AST_NODE_TYPES.RestElement:
          walkType(param.typeAnnotation?.typeAnnotation, {
            name: param.argument.type === TSESTree.AST_NODE_TYPES.Identifier ? param.argument.name : "value",
            element: false,
          });
          return;
        case TSESTree.AST_NODE_TYPES.AssignmentPattern:
        case TSESTree.AST_NODE_TYPES.ArrayPattern:
        case TSESTree.AST_NODE_TYPES.ObjectPattern:
          walkType(param.typeAnnotation?.typeAnnotation, { name: "value", element: false });
          return;
        default:
          return;
      }
    }

    function nameOfKey(node: TSESTree.Node): string {
      if (node.type === TSESTree.AST_NODE_TYPES.Identifier) return node.name;
      if (node.type === TSESTree.AST_NODE_TYPES.Literal) return String(node.value);
      return "value";
    }

    function walkMember(member: TSESTree.TypeElement): void {
      switch (member.type) {
        case TSESTree.AST_NODE_TYPES.TSPropertySignature:
          walkType(member.typeAnnotation?.typeAnnotation, {
            name: nameOfKey(member.key),
            element: false,
          });
          return;
        case TSESTree.AST_NODE_TYPES.TSMethodSignature:
          walkSignature(member, nameOfKey(member.key));
          return;
        case TSESTree.AST_NODE_TYPES.TSCallSignatureDeclaration:
        case TSESTree.AST_NODE_TYPES.TSConstructSignatureDeclaration:
          walkSignature(member, "value");
          return;
        case TSESTree.AST_NODE_TYPES.TSIndexSignature:
          // Key exempt (TS permits string/number/symbol only); value checked.
          walkType(member.typeAnnotation?.typeAnnotation, { name: "value", element: true });
          return;
        default:
          return;
      }
    }

    // --- the public boundary --------------------------------------------------

    /** Declarations reachable from an export, by name (overloads share one). */
    const declared = new Map<string, TSESTree.Node[]>();
    const exportedNames = new Set<string>();
    const checked = new Set<TSESTree.Node>();

    function declare(node: TSESTree.Node, name: string | undefined): void {
      if (name === undefined) return;
      const list = declared.get(name);
      if (list) list.push(node);
      else declared.set(name, [node]);
    }

    function checkDeclaration(node: TSESTree.Node): void {
      if (checked.has(node)) return;
      checked.add(node);
      switch (node.type) {
        case TSESTree.AST_NODE_TYPES.TSInterfaceDeclaration: {
          // A wire input is primitives by definition: its validated twin is
          // the branded `<X>Command` declared beside it (ADR LEG-2026-059).
          if (wireInputs.has(node.id.name)) return;
          // A concept's own wire form: `value` and `toJSON()` ARE the
          // primitive the brand wraps. Every other member is still walked.
          const branded = isBranded(node);
          for (const member of node.body.body) {
            if (branded && isWireFormMember(member)) continue;
            walkMember(member);
          }
          return;
        }
        case TSESTree.AST_NODE_TYPES.TSTypeAliasDeclaration:
          walkType(node.typeAnnotation, {
            name: node.id.name,
            element: false,
            aliasName: node.id.name,
          });
          return;
        case TSESTree.AST_NODE_TYPES.TSDeclareFunction:
        case TSESTree.AST_NODE_TYPES.FunctionDeclaration:
          walkSignature(node, node.id ? node.id.name : "value");
          return;
        case TSESTree.AST_NODE_TYPES.VariableDeclaration:
          for (const d of node.declarations) {
            if (d.id.type !== TSESTree.AST_NODE_TYPES.Identifier) continue;
            walkType(d.id.typeAnnotation?.typeAnnotation, { name: d.id.name, element: false });
          }
          return;
        // ClassDeclaration: exempt — a class is already nominal (see header).
        default:
          return;
      }
    }

    /** Index a top-level statement, queueing it for checking if exported.
     *  Nothing is checked during indexing: the parse-boundary exemption needs
     *  the whole file's value objects known first, so declaration order in the
     *  contract must not change the verdict. */
    function indexStatement(node: TSESTree.Node, exported: boolean): void {
      switch (node.type) {
        case TSESTree.AST_NODE_TYPES.TSTypeAliasDeclaration:
          declare(node, node.id.name);
          if (isValueObjectDefinition(node.typeAnnotation)) valueObjects.add(node.id.name);
          break;
        case TSESTree.AST_NODE_TYPES.TSInterfaceDeclaration:
          declare(node, node.id.name);
          interfaces.set(node.id.name, node);
          break;
        case TSESTree.AST_NODE_TYPES.TSDeclareFunction:
        case TSESTree.AST_NODE_TYPES.FunctionDeclaration:
          declare(node, node.id?.name);
          break;
        case TSESTree.AST_NODE_TYPES.VariableDeclaration:
          for (const d of node.declarations) {
            if (d.id.type === TSESTree.AST_NODE_TYPES.Identifier) declare(node, d.id.name);
          }
          break;
        case TSESTree.AST_NODE_TYPES.TSModuleDeclaration:
          // Ambient namespace: every member of an ambient block is exported.
          if (node.body) {
            for (const stmt of node.body.body) indexStatement(unwrapExport(stmt), true);
          }
          return;
        default:
          break;
      }
      if (exported) pending.push(node);
    }

    /** Exported declarations, in source order, checked after indexing. */
    const pending: TSESTree.Node[] = [];

    // --- the concept form (ADR LEG-2026-059) ----------------------------------------

    /** Interfaces named `<X>Input` whose `<X>Command` is branded in this file. */
    const wireInputs = new Set<string>();
    const interfaces = new Map<string, TSESTree.TSInterfaceDeclaration>();

    function isBranded(node: TSESTree.TSInterfaceDeclaration): boolean {
      return node.body.body.some(
        (m) =>
          m.type === TSESTree.AST_NODE_TYPES.TSPropertySignature &&
          m.key.type === TSESTree.AST_NODE_TYPES.Identifier &&
          m.key.name === "__brand" &&
          m.typeAnnotation?.typeAnnotation.type === TSESTree.AST_NODE_TYPES.TSLiteralType,
      );
    }

    function isWireFormMember(member: TSESTree.TypeElement): boolean {
      if (member.type === TSESTree.AST_NODE_TYPES.TSPropertySignature) {
        return member.key.type === TSESTree.AST_NODE_TYPES.Identifier && member.key.name === "value";
      }
      return member.type === TSESTree.AST_NODE_TYPES.TSMethodSignature &&
        member.key.type === TSESTree.AST_NODE_TYPES.Identifier && member.key.name === "toJSON" &&
        member.params.length === 0;
    }

    function unwrapExport(stmt: TSESTree.Node): TSESTree.Node {
      return stmt.type === TSESTree.AST_NODE_TYPES.ExportNamedDeclaration && stmt.declaration
        ? stmt.declaration
        : stmt;
    }

    return {
      Program(program) {
        for (const stmt of program.body) {
          switch (stmt.type) {
            case TSESTree.AST_NODE_TYPES.ExportNamedDeclaration:
              if (stmt.declaration) {
                indexStatement(stmt.declaration, true);
              } else if (!stmt.source) {
                // `export { Foo }` — Foo is declared locally; resolve below.
                for (const spec of stmt.specifiers) {
                  if (spec.local.type === TSESTree.AST_NODE_TYPES.Identifier) {
                    exportedNames.add(spec.local.name);
                  }
                }
              }
              break;
            case TSESTree.AST_NODE_TYPES.ExportDefaultDeclaration:
              indexStatement(stmt.declaration as TSESTree.Node, true);
              break;
            default:
              indexStatement(stmt, false);
          }
        }
        for (const name of exportedNames) {
          for (const node of declared.get(name) ?? []) pending.push(node);
        }
        for (const [name, node] of interfaces) {
          const command = interfaces.get(`${name.slice(0, -"Input".length)}Command`);
          if (name.endsWith("Input") && command !== undefined && isBranded(command)) wireInputs.add(node.id.name);
        }
        // Source order keeps the gate's output stable and greppable.
        pending.sort((a, b) => a.range[0] - b.range[0]);
        for (const node of pending) checkDeclaration(node);
      },
    };
  },
});
