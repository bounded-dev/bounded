import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noNakedPrimitives } from "./no-naked-primitives.ts";

// TN-26-001 architect zone rule (issue #3): value objects over primitives on a
// contract's *public* surface. Dogfood evidence (docs/dogfooding.md runs 1-3):
// Haiku shipped `isbn: string` / `pagesRead: number` / `authors: string[]`
// where Sonnet shipped `Isbn` / `PagesRead` / `AuthorName`, and every gate
// passed. This rule is the block that was missing.
//
// The valid[] list is the load-bearing half: a rule that fires on correct
// designs gets switched off. Which files this applies to (**/*.contract.ts)
// is gate wiring, not the rule.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-naked-primitives", noNakedPrimitives, {
  valid: [
    // --- the value-object vocabulary the skill prescribes ---
    'export type Isbn = string & { readonly __brand: "Isbn" };\nexport interface Book { isbn: Isbn }',
    'export type PagesRead = number & { readonly __brand: "PagesRead" };',
    // brand via a helper alias: the primitive sits in a type argument of a
    // type the rule does not see through — caller's choice, not our business
    'export type Isbn = Brand<string, "Isbn">;',
    // string-literal unions ARE value objects (and the enum replacement)
    "export type Status = 'open' | 'paid';\nexport interface Order { status: Status }",
    "export interface Order { status: 'open' | 'paid' }",
    // template-literal types are constrained patterns, not naked strings
    "export type Slug = `${string}-${number}`;",

    // --- non-domain types are out of scope ---
    "export interface Port { save(o: Order): Promise<void> }",
    "export interface X { a: void; b: never; c: unknown; d: boolean; e: symbol }",
    // boolean is deliberately out of scope (see the rule header)
    "export interface Book { archived: boolean }",

    // --- positions where a primitive is correct, not a defect ---
    // index-signature key: TS permits nothing else
    "export interface ByIsbn { [isbn: string]: Book }",
    // Record/Map KEY is an index domain, same reasoning
    "export interface Catalog { byIsbn: Record<string, Book> }",
    "export interface Catalog { byIsbn: ReadonlyMap<string, Book> }",
    // type parameters and their constraints are the caller's choice
    "export interface Box<T> { value: T }",
    "export declare function pick<K extends string>(k: K): K;",
    // opaque generics are not transparent containers — we do not look inside
    "export interface R { result: Result<string, DomainError> }",

    // --- the public boundary only ---
    "interface Internal { isbn: string }", // unexported: not the boundary
    "type Raw = string;", // unexported alias: not the boundary
    // a concept's own wire form (ADR 2026-059): `value` and `toJSON()` ARE
    // the primitive the brand wraps
    'export interface Money { readonly __brand: "Money"; readonly value: number; equals(other: Money): boolean; toJSON(): number; }',
    // an entity's toJSON is its wire shape
    'export interface Note { readonly __brand: "Note"; readonly id: NoteId; toJSON(): { readonly id: string }; }',
    // a wire input beside its branded command (TN-26-012 §3)
    `export interface CreateNoteInput { readonly projectId: string; readonly text: string; }
export interface CreateNoteCommand { readonly __brand: "CreateNoteCommand"; readonly projectId: ProjectId; readonly text: NoteText; }`,

    // --- the parse boundary: a signature that RETURNS a value object
    // declared in this contract may take the raw primitive. This is where
    // primitives are supposed to enter the domain, and it is the rule's
    // escape hatch — one that improves the design instead of suppressing it.
    'export type Isbn = string & { readonly __brand: "Isbn" };\nexport declare function parseIsbn(raw: string): Isbn;',
    // the non-throwing variant
    'export type Isbn = string & { readonly __brand: "Isbn" };\nexport declare function parseIsbn(raw: string): Isbn | undefined;',
    // async parse, and declaration order must not matter
    'export declare function parseIsbn(raw: string): Promise<Isbn>;\nexport type Isbn = string & { readonly __brand: "Isbn" };',
    // method form, on a port
    'export type Isbn = string & { readonly __brand: "Isbn" };\nexport interface IsbnCodec { parse(raw: string): Isbn }',
    // literal-union value objects are value objects here too
    "export type Status = 'open' | 'paid';\nexport declare function parseStatus(raw: string): Status;",
    // the brand's base need not match the input primitive
    'export type PagesRead = number & { readonly __brand: "PagesRead" };\nexport declare function parsePages(raw: string): PagesRead;',

    // --- composite shapes built from value objects ---
    "export interface Book { authors: readonly [AuthorName, ...AuthorName[]] }",
    "export interface Book { tags: readonly Tag[] }",
    'export type NewOrder = Omit<Order, "id">;',
    "export declare const DEFAULT_CURRENCY: CurrencyCode;",
    "export default interface Config { level: LogLevel }",

    // --- built-in object types: only the ALIAS position is the defect ---
    // The canonical value object (ADR 2026-059) — the fix a flagged alias is
    // pointed at, so it must never be flagged itself.
    `export interface CalendarDate {
      readonly __brand: "CalendarDate";
      readonly value: string;
      equals(other: CalendarDate): boolean;
      toJSON(): string;
    }
    export interface CalendarDateFactory {
      parse(raw: unknown): Result<CalendarDate>;
    }`,
    // a Date-typed member is a design judgement, not this rule's business
    "export interface Subscription { expiresAt: Date }",
    "export declare function renewedAt(at: Date): Subscription;",
    "export interface Catalog { byIsbn: ReadonlyMap<Isbn, Book> }",
    // containers at their use sites are fine; it is the alias that claims to
    // be a named domain type
    "export interface Shelf { readonly books: readonly Book[] }",
    // unexported: not the public boundary
    "type CalendarDate = Date;",
    // nested is not the alias position: an object alias is a DTO, not a claim
    // to be a value object
    "export type Schedule = { readonly at: Date };",
    // an alias to a project type is not a built-in — the set is closed
    "export type Timestamp = InstantOf<Clock>;",
    "export type NewOrder = Omit<Order, 'id'>;",
    // re-exports declare nothing here
    'export type * from "./other.contract.ts";',
    "",
  ],

  invalid: [
    // --- the concept exemptions are exact (ADR 2026-059) ---
    // a branded interface's OTHER members are still walked
    {
      code: 'export interface Money { readonly __brand: "Money"; readonly value: number; readonly currency: string; toJSON(): number; }',
      errors: [{ messageId: "nakedPrimitive", data: { name: "currency", brand: "Currency", stem: "currency", primitive: "string" } }],
    },
    // a `value` field on an unbranded interface is an ordinary slot
    {
      code: "export interface Money { readonly value: number; }",
      errors: [{ messageId: "nakedPrimitive", data: { name: "value", brand: "Value", stem: "value", primitive: "number" } }],
    },
    // a toJSON that takes arguments is behaviour, not the wire form
    {
      code: 'export interface Money { readonly __brand: "Money"; toJSON(locale: string): string; }',
      errors: [
        { messageId: "nakedPrimitive", data: { name: "locale", brand: "Locale", stem: "locale", primitive: "string" } },
        { messageId: "nakedPrimitive", data: { name: "toJSON", brand: "ToJson", stem: "to-json", primitive: "string" } },
      ],
    },
    // an Input with no branded Command twin is an ordinary DTO
    {
      code: "export interface CreateNoteInput { readonly text: string; }",
      errors: [{ messageId: "nakedPrimitive", data: { name: "text", brand: "Text", stem: "text", primitive: "string" } }],
    },
    // a twin without a brand does not count
    {
      code: "export interface CreateNoteInput { readonly text: string; }\nexport interface CreateNoteCommand { readonly text: NoteText; }",
      errors: [{ messageId: "nakedPrimitive", data: { name: "text", brand: "Text", stem: "text", primitive: "string" } }],
    },
    // --- the three dogfood defects, verbatim ---
    {
      code: "export interface Book { isbn: string }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", stem: "isbn", primitive: "string" } },
      ],
    },
    {
      code: "export interface ProgressEvent { pagesRead: number }",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "pagesRead", brand: "PagesRead", stem: "pages-read", primitive: "number" },
        },
      ],
    },
    {
      code: "export interface Book { authors: string[] }",
      errors: [
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "authors", brand: "Author", stem: "author", primitive: "string" },
        },
      ],
    },
    {
      // Haiku's filter argument, run 2
      code: "export interface BookFilter { author?: string }",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "author", brand: "Author", stem: "author", primitive: "string" },
        },
      ],
    },

    // --- aliases are not value objects: assignable from every other string ---
    {
      code: "export type Isbn = string;",
      errors: [
        { messageId: "primitiveAlias", data: { name: "Isbn", primitive: "string" } },
      ],
    },
    {
      code: "export type Id = string | number;",
      errors: [
        { messageId: "primitiveAlias", data: { name: "Id", primitive: "string" } },
        { messageId: "primitiveAlias", data: { name: "Id", primitive: "number" } },
      ],
    },

    // --- bare aliases to built-in object types (issue #10, issue #13) ---
    {
      // dogfood Run 4 verbatim: the invariant lived in a doc comment, the type
      // was assignable from every Date in the program, and Date is mutable
      code: "export type CalendarDate = Date;",
      errors: [{ messageId: "builtinAlias" }],
    },
    {
      code: "export type Expiry = Date | undefined;",
      errors: [{ messageId: "builtinAlias" }],
    },
    {
      // generic built-ins are the same shape one container out
      code: "export type Registry = Map<Isbn, Book>;",
      errors: [{ messageId: "builtinAlias" }],
    },
    {
      code: "export type Shelf = Set<Isbn>;",
      errors: [{ messageId: "builtinAlias" }],
    },
    {
      code: "export type PendingBook = Promise<Book>;",
      errors: [{ messageId: "builtinAlias" }],
    },
    {
      code: "export type Pattern = RegExp;",
      errors: [{ messageId: "builtinAlias" }],
    },
    // both array spellings must agree — an agent cannot comply with a rule
    // whose verdict depends on which one it typed
    {
      code: "export type Authors = Array<AuthorName>;",
      errors: [{ messageId: "builtinAlias" }],
    },
    {
      code: "export type Authors = readonly AuthorName[];",
      errors: [{ messageId: "builtinAlias" }],
    },
    {
      // additive: the alias is one defect, its naked element another
      code: "export type Tags = string[];",
      errors: [{ messageId: "builtinAlias" }, { messageId: "nakedPrimitiveElement" }],
    },
    {
      // reached through a specifier export like every other boundary route
      code: "type CalendarDate = Date;\nexport { CalendarDate };",
      errors: [{ messageId: "builtinAlias" }],
    },
    // --- declare function / declare const ---
    {
      code: "export declare function findBook(isbn: string): Book;",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", stem: "isbn", primitive: "string" } },
      ],
    },
    {
      code: "export declare function countBooks(): number;",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "countBooks", brand: "CountBooks", stem: "count-books", primitive: "number" },
        },
      ],
    },
    {
      code: "export declare const DEFAULT_CURRENCY: string;",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "DEFAULT_CURRENCY", brand: "DefaultCurrency", stem: "default-currency", primitive: "string" },
        },
      ],
    },

    // --- the parse-boundary exemption is narrow: only the PARAMETERS, and
    // only when the return really is a value object declared here ---
    {
      // returns a DTO, not a value object
      code: "export interface Book { isbn: Isbn }\nexport declare function findBook(isbn: string): Book;",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", stem: "isbn", primitive: "string" } },
      ],
    },
    {
      // the return position is never exempt, even on a parse-shaped function
      code: 'export type Isbn = string & { readonly __brand: "Isbn" };\nexport declare function unwrap(isbn: Isbn): string;',
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "unwrap", brand: "Unwrap", stem: "unwrap", primitive: "string" },
        },
      ],
    },
    {
      // an unbranded local alias is not a value object, so it exempts nothing
      code: "type Isbn = string;\nexport declare function parseIsbn(raw: string): Isbn;",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "raw", brand: "Raw", stem: "raw", primitive: "string" } },
      ],
    },

    // --- ports get the same treatment as DTOs (see the rule header) ---
    {
      code: "export interface BookStore { get(key: string): Promise<Book | undefined> }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "key", brand: "Key", stem: "key", primitive: "string" } },
      ],
    },
    {
      code: "export interface BookStore { load(): Promise<string> }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "load", brand: "Load", stem: "load", primitive: "string" } },
      ],
    },

    // --- collections: element type is the same sin one level down ---
    {
      code: "export interface Book { readonly tags: readonly string[] }",
      errors: [
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "tags", brand: "Tag", stem: "tag", primitive: "string" },
        },
      ],
    },
    {
      code: "export interface Book { authors: Array<string> }",
      errors: [
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "authors", brand: "Author", stem: "author", primitive: "string" },
        },
      ],
    },
    {
      code: "export interface Book { authors: ReadonlySet<string> }",
      errors: [
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "authors", brand: "Author", stem: "author", primitive: "string" },
        },
      ],
    },
    {
      // a non-empty tuple of naked strings still loses the domain type
      code: "export interface Book { authors: readonly [string, ...string[]] }",
      errors: [{ messageId: "nakedPrimitiveElement" }, { messageId: "nakedPrimitiveElement" }],
    },
    {
      // Record/Map VALUE position is a domain slot (the key is not)
      code: "export interface Catalog { titles: Record<Isbn, string> }",
      errors: [
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "titles", brand: "Title", stem: "title", primitive: "string" },
        },
      ],
    },

    // --- unions, nesting, function-typed members ---
    {
      code: "export interface Book { subtitle: string | undefined }",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "subtitle", brand: "Subtitle", stem: "subtitle", primitive: "string" },
        },
      ],
    },
    {
      code: "export interface Book { meta: { isbn: string } }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", stem: "isbn", primitive: "string" } },
      ],
    },
    {
      code: "export interface Book { onRename: (title: string) => void }",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "title", brand: "Title", stem: "title", primitive: "string" },
        },
      ],
    },

    // --- every route onto the public boundary is checked ---
    {
      code: "interface Book { isbn: string }\nexport { Book };",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", stem: "isbn", primitive: "string" } },
      ],
    },
    {
      code: "export default interface Config { host: string }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "host", brand: "Host", stem: "host", primitive: "string" } },
      ],
    },
    {
      code: "export declare namespace Books { interface Repo { get(isbn: string): Book } }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", stem: "isbn", primitive: "string" } },
      ],
    },

    // --- multiple sins, multiple reports, source order ---
    {
      code: "export interface Book { isbn: string; authors: string[]; pages: number }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", stem: "isbn", primitive: "string" } },
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "authors", brand: "Author", stem: "author", primitive: "string" },
        },
        {
          messageId: "nakedPrimitive",
          data: { name: "pages", brand: "Pages", stem: "pages", primitive: "number" },
        },
      ],
    },
  ],
});
