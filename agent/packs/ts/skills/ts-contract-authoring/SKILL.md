---
name: ts-contract-authoring
description: Author TypeScript design contracts (`*.contract.ts`) for the developer-stage pipeline — the contract-owns-the-name form of ADR 2026-059 for domain concepts (value objects, identifiers, entities), declaration-only and value objects over primitives, then gate and emit. Use when writing or revising a contract, or when acting as the architect role.
---

# TS contract authoring

A contract is a concept's or a feature's **typed public surface**: the shape the
test-writer tests against and the builder implements. The architect writes
contracts; everything mechanical derived from them — implementation skeletons,
barrels, command files, adapters, laws — is **generated**, and the builder never
edits a contract.

**A complete worked example lives at `packs/ts/reference/` — read it before
writing your first contract.** It is the worked example's domain
(`contexts/project-management/src/domain`): six concepts with their contracts,
implementations, generated laws and hand-written tests, kept green by the
harness's own suite (TN-26-008). Copy the *shape*, not the domain.

## Layout and naming (TN-26-012)

- Domain concept: `contexts/<context>/src/domain/<area>/<concept>.contract.ts`.
  The file stem is the kebab-case of the concept name (`NoteId` →
  `note-id.contract.ts`), one concept per file; `<area>` is a plural business
  noun (`notes`, `projects`).
- Feature: `contexts/<context>/src/application/<area>/<feature>/<feature>.contract.ts`
  — input, command, in port and out ports. Its rules are the `ts-hexagonal`
  skill's; the import and purity rules below apply to it too.
- The emitter derives the rest: `<concept>.contract.ts` → the skeleton
  `<concept>.ts` (then the builder's) and the generated laws
  `<concept>.laws.test.ts` beside it. Never create either by hand.
- The ticket's design note (`docs/tn/TN-<ticket>.md`) holds what types cannot:
  validity rules, ordering, identity, invariants. Its front matter lists the
  contracts the ticket owns.

## The contract owns the name (ADR 2026-059)

Every domain concept is a pair of interfaces: the instance side, named after
the concept with no suffix, and the static side, `<Name>Factory`. The
implementation file hides a class `<Name>Impl` and ends with two exports that
make `<Name>` one name for both the type and the value:

```ts
// project-name.contract.ts — written by the architect
import type { Result } from "../shared/result.ts";

/**
 * The name of a project: any string that is not empty once trimmed.
 * @accepts "Website relaunch"
 * @accepts "Office move"
 */
export interface ProjectName {
  readonly __brand: "ProjectName";
  readonly value: string;
  equals(other: ProjectName): boolean;
  toJSON(): string;
}

export interface ProjectNameFactory {
  parse(raw: unknown): Result<ProjectName>;
}
```

```ts
// project-name.ts — emitted as a skeleton; the builder writes the class body
import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./project-name.contract.ts";

const schema = z.string().trim().min(1, "Project name is required");

class ProjectNameImpl implements Contract.ProjectName {
  declare readonly __brand: "ProjectName";
  private constructor(readonly value: string) {}

  static parse(raw: unknown): Result<ProjectName> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new ProjectNameImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid project name" };
  }

  equals(other: ProjectName): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type ProjectName = Contract.ProjectName;
export const ProjectName: Contract.ProjectNameFactory = ProjectNameImpl;
```

Consumers import one name and use it both ways: `ProjectName.parse(raw)` and
`name: ProjectName`. The `implements` clause checks the instance side against
the contract; the `const` annotation checks the static side against the
factory. `impl-tail` holds the tail exactly as generated.

### The three kinds

The factory decides the kind, and each is held by a contract lint rule:

| Kind | Factory | Instance | Rule |
|---|---|---|---|
| value object | `parse(raw: unknown): Result<Name>` | `readonly __brand: "Name"`, exactly one `readonly value: string \| number \| boolean`, `equals(other: Name): boolean`, `toJSON(): <value's type>` | `value-object-shape` |
| identifier | `generate(): Name` and `parse` | as a value object | `value-object-shape` |
| entity | exactly one `new (…fields): Name` | brand, `readonly id: <Name>Id` first, then value objects / identifiers; `equals`; `toJSON(): { readonly <field>: <primitive>; … }` one per field, in order | `entity-shape` |

- **The brand is first and matches the name.** It stops an object literal from
  passing as the concept; a brand string that differs from the name silently
  makes two unrelated types.
- **`parse` returns `Result`, never `T | undefined`.** A refusal carries its
  reason (`{ ok: false, error }`), and `unknown` lets the generated laws hand
  it hostile input.
- **An entity is built from already-valid value objects**, so its factory is
  a public `new (…)` whose parameters ARE the fields — same names, same
  types, same order. It has no `parse`. It refers to an entity in another area
  by its id value object, never by holding it.
- **Behaviour goes on the instance side.** Extra methods are welcome and are
  skeletoned in declaration order; extra factory members are not (the factory
  is `parse`/`generate` or one `new`).
- Accessors, index and call signatures, optional or overloaded members are
  refused: every member becomes a line of the generated class.

### Imports: contracts only (`contract-imports-contracts-only`)

Every contract, wherever it lives, imports only other contracts and the
shared `Result`, always as `import type { … }` — never an implementation
file, and never through an `import("…")` type expression (a frozen design may
not depend on builder-written code). Outside the hexagonal layers a contract
may also import a package or a composed pack's shipped support module:

```ts
import type { ProjectId } from "../projects/project-id.contract.ts";  // ✓
import type { Result } from "../shared/result.ts";                    // ✓
import type { ProjectId } from "../projects/project-id.ts";            // ✗ an implementation
import { type ProjectId } from "./project-id.contract.ts";             // ✗ inline type
import type { NoteId } from "./note-id.contract.js";                   // ✗ .js specifier
```

An **application** contract may also import its context's generated domain
barrel, `import type { Note, NoteText, Result } from "@<scope>/<context>/domain";`
(lead decision Q3): the barrel is generated, so the import cannot reach an
implementation body. A domain contract may not. Contracts re-export nothing.

This inverts the retired rule (`no-cross-contract-type-import`), which existed
only because the old `declare class` form declared every class twice. Under
this form the contract is the concept's only declaration, so importing it is
the one right way to reach it.

## Declaration-only vocabulary (`declaration-only`)

Allowed: `export interface …`, `export type …` (string-literal unions for
enumerations), `import type …`. Legacy non-hexagonal contracts may still use
`export declare function` / `export declare const`.

Refused, each with a message that says where the code belongs: function
bodies, value bindings, runtime classes, **`declare class`** (the retired
ADR 2026-015 contract form — the message prints the interface + factory pair
to write instead), enums, runtime namespaces, value imports, `export =`,
default-exported values.

## Value objects over primitives (`no-naked-primitives`, `no-branded-aliases`)

A naked `string`/`number` on a contract's public surface is refused: it
carries no domain meaning and no invariant. The message names the value
object to declare and the file to put it in. What stays legal, so you can
predict the rule:

- a concept's own wire form — `value` and `toJSON()` in a branded interface;
- a feature's `<X>Input` beside its branded `<X>Command` (what callers send);
- string-literal and template-literal unions, `boolean`, `void`/`unknown`,
  type parameters, index-signature and `Record`/`Map` key positions.

Branded aliases are refused outright — `string & { readonly __brand: "Isbn" }`
(optional brand: enforces nothing; required brand: needs a cast the builder
may not write), `export type Isbn = string`, and aliases of built-ins such as
`export type CalendarDate = Date` (mutable, and assignable from every Date).
Declare the concept pair instead.

**Encode cardinality in the type.** "One or more authors" is
`readonly [AuthorName, ...AuthorName[]]`, not `AuthorName[]`.

Nothing from zod may appear in a contract (`no-schema-on-surface`): the schema
is the engine inside `<Name>Impl` (ADR 2026-031), and the contract's whole
validation surface is the factory's `parse`.

## The generated laws, and what they need from you

The domain emitter writes `<concept>.laws.test.ts` beside every concept, run
by `bun test` and write-denied for every role:

- **value object** — `parse` refuses cross-type junk (`null`, `[]`, `0` for a
  string, `NaN`) and gives a reason; toJSON is the wire form and round-trips
  through `parse`; parsing is deterministic; `equals` is reflexive, by value,
  and discriminates two different values.
- **identifier** — all of that, plus `generate()` yields distinct, parseable
  identifiers.
- **entity** — equality by identity (same id, different content: equal;
  different id: not), `toJSON` is each field's own wire form, and every id in
  it parses back to the same identifier.

A law needs a valid input. An identifier supplies its own (`generate()`); a
value object's comes from **`@accepts` tags** on its instance interface.
**Every value object must carry a doc comment stating its validity rule and
two different `@accepts` examples** — `value-object-documented` refuses the
contract otherwise, checks each is a literal of the value's type, and refuses
two that are the same once whitespace is trimmed. So no law is ever skipped:
the test-writer reads the rule, the first example runs the value laws (and the
identity laws of every entity holding the value object), and the second is
what "equals discriminates" compares against.

What no generator can know is left to the test-writer's `<concept>.test.ts`:
an input of the **right type and the wrong value** (`""` for a project name,
`"project-1"` for a UUID id). Name every axis of the rule in the doc comment —
length, case, character class, range — so each becomes a rejection case the
test-writer chooses deliberately rather than guesses.

## Design for testability before you freeze

The test-writer works through the contract and nothing else. Check every
concept and port against these; a failure means revising the contract, not
the tests:

1. **Single purpose** — one reason to exist, one behaviour to name.
2. **Pure where possible** — output determined by input alone.
3. **Side effects are ports** — time, IO, randomness and persistence are out
   ports declared in the feature contract and injected, never reached directly.
4. **Callable through the contract alone** — if a test would need anything the
   interface does not expose, the contract is incomplete.

## Escape hatches

Implementation code bans `!`, `as`, `any` and `@ts-expect-error`, and inline
`eslint-disable` comments cannot reopen them. The concept form is what makes
the ban livable: `parse` builds with `new <Name>Impl(…)` behind a zod schema,
so a correct implementation needs none of the four. If you reach for one, the
contract is usually wrong — raise a `CONTRACT-DISPUTE`.

There is no lint config in the target project to weaken: the gates build
their ESLint config programmatically and consult no project file.

## After writing: gate, then emit

In the developer-stage pipeline the architect has no shell and needs none:
call `contract_purity` while iterating and `design_gate` to advance the phase —
purity, then the emitters (skeletons, laws, generated files), then the
typecheck, the design review and the freeze, one call and one verdict. A
failure at design always routes to you: nothing downstream exists yet.

`contract-purity` exit codes: 0 clean · 1 problems listed · 2 no files
matched (treat 2 as an error — a gate that matches nothing is broken).

## What the surface check asks of an implementation

For a concept, the compiler checks both sides through the tail, so
`surface-check` asks only what the compiler cannot see: that the file still
ends with the two generated exports, and that it exports nothing else — no
`<Name>Impl`, no schema, no helper. (Legacy flat-layout contracts are still
compared member by member.)

## The guard log

Every gate and generator appends to `.bounded/guard-log.jsonl` — blocks where
a guard caught drift, and passes as proof it ran. Don't edit it.
