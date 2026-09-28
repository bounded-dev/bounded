---
name: ts-contract-authoring
description: Author a component contract (`*.contract.ts`) for the developer-stage pipeline (TN-26-001) — declaration-only typed surface, ports for side effects, then gate + scaffold. Use when writing or revising a component's contract/spec, or when acting as the architect role.
---

# TS contract authoring

A contract is the component's **typed public surface**: types, interfaces and
ambient (`declare`) declarations — the shape the test-writer tests against and
the builder implements. Contracts are written by the architect; skeletons are
**machine-generated** from them; the contract file itself is never edited by
the builder.

**A complete worked example lives at `packs/ts/reference/README.md` — read it before
writing your first contract.** It is a gate-verified component (contract, value
objects, tests, implementation) in a neutral domain, kept green by CI (TN-26-008).
Copy the *shape* — nominal value-object class, one value object per file,
`@accepts`-documented rule, the `<Name> — boundaries` test block — not the
domain.

## Layout and naming (fixed rules)

The ticket's design note is `docs/tn/TN-<ticket-number>.md` in a project using
ticket-numbered TNs, for the ticket the team lead selected in
`.bounded/active-ticket` (`BOUNDED_TICKET` is only an explicit override). Legacy projects use
`spec.md`. The note's front matter lists the contracts this ticket owns.

- Contract: `src/<component>/<component>.contract.ts` — colocated with the component.
- The scaffolder derives the implementation path: `foo.contract.ts` → sibling `foo.ts`. Never create the sibling by hand.
- Spec lives in the ticket's design note; one component per loop iteration.

## One identity per value object — a contract never imports from a contract

**Cross-component types are imported from the implementation module, never from
another `*.contract.ts`.**

```ts
import type { Money } from "../values/values.js";           // the only legal form
import type { Money } from "../values/values.contract.js";  // REFUSED at scaffold
```

The reason is the nominal class itself. A contract's `declare class Money` and
the runtime `class Money` the scaffolder writes into that contract's sibling
implementation module are two declarations of the same private `__brand`, and
TypeScript treats those as unrelated types. Reach for `Money` through the
contract and you get the ambient one; the only legal way to *build* a `Money` is
`Money.parse`, which returns the other one. Every operation declared that way is
an operation nothing can call. The implementation module is the fix, and it is a
total fix: the scaffolder makes it re-export every type its own contract
declares, so the implementation module is a superset of the contract's surface,
and it shadows the ambient class with the real one.

This is enforced, not advised. The scaffolder rejects both the import and the
`export type … from` re-export of another contract, at scaffold time, with a
`ScaffoldError` carrying the exact replacement line — the architect fixes the
contract, never the skeleton (ADR 2026-023). Do not try to route around it by
redirecting only the generated skeleton's imports: a contract's own interfaces
(`Receipt { total: Money }`) carry the wrong identity too, so the second
declaration has to be unreachable, and only the contract can arrange that.

Read plainly: **a component's public surface is its implementation module, and
its contract is private to its own skeleton.** Write contracts accordingly.

**The same clash has a same-file twin: a value object and the operations over
it may not share a contract file.** Declare a nominal value-object class and, in
the same file, an interface / type-alias / operation / const that references it —

```ts
export declare class BuildingId { private readonly __brand: "BuildingId"; /* … */ }
export interface Report { readonly id: BuildingId; }    // BLOCKED — value-objects-own-contract
export declare function rate(id: BuildingId): number;   // BLOCKED — value-objects-own-contract
```

— and the scaffolder emits `BuildingId` as a runtime class in that file's
skeleton, so a same-file reference binds the runtime identity while the
skeleton's conformance check compares against the contract's ambient `declare
class`: two `__brand` declarations, and the skeleton does not compile. The fix
is decomposition, the shape multi-file designs already use: the value objects go
in their own `*.contract.ts`, and the operations import them from the
implementation module (`import type { BuildingId } from "../ids/ids.js"`), which
resolves to one identity (ADR 2026-023). This is enforced, not advised: the
`value-objects-own-contract` rule refuses the same-file shape at
`contract_purity`, naming the value object to move (ADR 2026-026). A contract
file holds one cohesive area — a value object is its own area; the operations
over it are another. (Value objects may live together — a vocabulary file of
several is fine, because a value object referencing another does not clash; what
may not share the file is the interfaces and operations that consume them.)

**A test that imports a value object from a `*.contract.js` reintroduces the
second identity in its own file.** Today that is a loud local type error at the
red gate rather than a rule — no lint blocks it, and it should. Import value
objects in tests from the implementation module, the same as everywhere else.

## Operations must exist at runtime

**An `export interface` is a TYPE. It vanishes at compile time.** So a contract
whose operations are only methods on an exported interface declares nothing to
implement: neither the test-writer nor the builder can obtain the thing to call
it. The scaffolder blocks this, because every gate before it — declaration-only,
value objects, typecheck, checksum — passes happily on a contract that cannot
be built.

Every operation needs a value export. Either declare each one:

```ts
export declare function renew(subscription: Subscription, input: RenewInput): ChargeOutcome;
```

or keep the interface as the shape and declare a factory that returns it:

```ts
export interface SubscriptionBilling { renew(…): ChargeOutcome; /* … */ }
export declare function createSubscriptionBilling(deps: Deps): SubscriptionBilling;
```

Either is fine. What is not fine is collapsing several operations into one
entry point to satisfy the rule — the fix is to make what you designed
callable, not to shrink it.

## Declaration-only vocabulary

Allowed:

- `export interface …`, `export type …` (exported or local)
- `export declare function name(…): T;` — overloads fine
- `export declare const NAME: T;` — explicit type required (prefer functions;
  a `declare const` throws at import time during the red phase)
- `export declare class Name { … }` — bodiless members
- `import type …`, `export type … from` — the module graph is type-only

Banned (the gate rejects these — read the error message, it tells you where
the code belongs):

- function bodies, arrow functions, any value binding (`const x = …`)
- runtime classes/enums/namespaces — **enums become string-literal unions**:
  `export type Status = "open" | "paid";`
- value imports (`import { Pool } from "pg"`) — concrete infra never appears
  in a contract; side effects sit behind **ports** (interfaces) instead
- `export =`, default-exported values, `any`, `as` casts
- **naked `string`/`number` on the public surface** — see "Value objects"
  below; the gate names the exact declaration to write instead

## Rules of thumb

- **Every type used by the public surface must be exported.** The scaffolder
  fails on a referenced-but-unexported type — that's your cue to export it.
- **Value objects over primitives** at the boundary — **enforced**, not
  advice: `contract-purity` runs `no-naked-primitives`, which blocks a naked
  `string`/`number` anywhere on the exported surface (interface members, port
  method parameters and returns, `declare function` signatures,
  `declare const`, array/tuple/`Set`/`Record`-value elements).

  ### The canonical shape is a nominal class

  A private brand, a private constructor, a static `parse` taking `unknown`.
  Write this unless you have a reason not to:

  ```ts
  export declare class Currency {
    private readonly __brand: "Currency";
    private constructor();
    readonly code: string;
    static parse(raw: unknown): Currency | undefined;
    equals(other: Currency): boolean;
  }
  ```

  Every part is load-bearing, and every claim below is a `tsc` error rather
  than a convention — verified against the dogfood tsconfig:

  | Part | What it refuses | Error |
  |---|---|---|
  | `private readonly __brand` | a structurally identical impostor, and any other value object of the same shape | TS2739 — "separate declarations of a private property" |
  | `private constructor` | `new Currency("usd")`, i.e. construction that skipped validation | TS2673 |
  | `static parse(raw: unknown)` | nothing — it is the single door in, and `unknown` lets it face parsed JSON directly | — |
  | `Currency \| undefined` | using the result without handling failure | TS2322 |
  | `readonly code` | mutation after construction | TS2540 |

  **The brand does the work, not the private constructor.** A private
  constructor stops `new`; it does not stop
  `const c: Currency = { code: "USD" }`, because instances stay structurally
  typed. It is the private *field* that flips TypeScript into nominal
  comparison. Drop the brand and you have a DTO in a value object's clothes.

  **Public `readonly` fields, never a private field plus a getter.** A
  parameter property — `private constructor(readonly code: string) {}` — is
  already nominal, already immutable, already compile-time enforced. A getter
  earns its place only for a *derived* value.

  **Other constructors are welcome.** `static of(minorUnits: number, currency:
  Currency)` for when the parts are already value objects. `parse` is the one
  that must exist, because it is the boundary; the rest are convenience.

  **Behaviour lives on the class** — `equals`, `plus`, `toString`. That is the
  whole reason to prefer it over a brand: an alias can only be passed around,
  a class can be asked things.

  This shape passes `contract_purity` as written: `declare class` bodies are
  exempt from `no-naked-primitives`, because a class is already nominal and
  its `parse` must accept the raw primitive.

  **The one place primitives are legitimate: `src/ui/shared/ui/`.** Contracts
  under the generic UI layer — and only there — have `no-naked-primitives`,
  `value-object-shape` and `value-object-documented` switched off, contributed
  by the ts-web pack (TN-26-006). A Button's `label: string` is a string: that
  layer holds no domain, which is what makes it reusable, and wrapping a label
  in a value object would be ceremony with no invariant behind it. Everywhere
  else — including `src/ui/entities/` and `src/ui/features/` — the rule stands,
  so domain data arrives at a feature component as a value object and is
  rendered to a primitive at the leaf. Moving a domain type into `shared/ui` to
  escape a block inverts the layer rule and `fsd-downward-imports` will refuse
  the import that made it useful.

  **It is also why `src/**` bans every type-system escape hatch.** A branded
  alias could only be built with `return raw as Isbn`, so casts had to be
  tolerated. A class is built with `new Currency(raw)`, and a composite parser
  narrows with `in` rather than casting, so a correct implementation needs no
  `as`, no `!`, and no `@ts-expect-error` anywhere. There is no exemption list
  to reason toward — see "Escape hatches" below.

  ### Branded aliases are banned — the class is the only form

  ```ts
  export type Isbn = string & { readonly __brand: "Isbn" };   // BLOCKED
  export type Id = string & { readonly __brand?: "Id" };      // BLOCKED
  export type Isbn = string;                                  // BLOCKED
  export type CalendarDate = Date;                            // BLOCKED
  ```

  The last one is the same defect wearing an object type: an alias to a
  built-in (`Date`, `RegExp`, `Map`, `Set`, `Array`, `Promise`) is assignable
  from every other value of that shape, and `Date` is mutable besides — a
  caller who kept a reference can rewrite what you validated. Store an
  immutable representation (an ISO-8601 `string`) inside the class instead.

  `contract-purity` runs `no-branded-aliases`, and the reasons are Run 9's:
  the **optional** brand is a costume — every bare string is assignable, and
  because no class exists, no law suite is generated and the boundaries
  obligation never fires, so a question mark disarms the whole coverage
  machinery. The **required** brand is incoherent under the escape-hatch ban:
  `raw as Isbn` is its only constructor and `as` is blocked in `src/` with no
  exemption list, so the contract would demand what the builder cannot legally
  write. The class has a real constructor; it is the only value-object shape
  that needs no escape hatch.

  Don't hand-write either form — the one typo that matters is invisible (a
  brand string that doesn't match the type name silently gives you two
  unrelated types). Generate the class:

  ```bash
  node "$SCRIPTS/new-value-object.ts" src/reading-list/book.contract.ts \
      Isbn BookTitle AuthorName PagesRead=number
  ```

  Base defaults to `string`; the generated class carries it as
  `readonly value: <base>` — a placeholder name, because only you know it is
  really `code` or `digits`. Re-running is a no-op, and an existing alias,
  bare or branded, is upgraded to the class in place rather than duplicated.
  (Expect `tsc` to complain at the use sites after an upgrade: a class is not
  assignable from a raw string, so each complaint is a place the primitive was
  leaking, named for you.)

  Then do the two things the generator will not: retype the members that
  triggered the violation, and replace `state what makes it valid` in each doc
  comment with the actual rule. Both are design calls, not the tool's.

  ### Known gap: the implementation side is unchecked

  `value-object-shape` runs at `contract_purity`, on contracts only. It is NOT
  run over `src/**`, and that is a deliberate limit rather than an oversight:
  in a contract an exported class is a value object, but an implementation
  legitimately exports classes that are not — the scaffolder's own generated
  `shared/errors.ts` exports `NotImplementedError`, and a rule that blocks
  every project on its own generated code is a rule that gets switched off.

  The cost is real and worth knowing: `scaffold-contract.ts` excludes nominal
  classes from the generated `__conformance` object, because a nominal class
  cannot be checked with a `typeof` comparison. So nothing stops a builder
  quietly dropping the private constructor or the brand — the tests would still
  pass. What catches it today is that the tests typecheck against the
  implementation, so a changed signature surfaces there. A shape check that knew
  which src classes the contract declares would close this properly.

  ### Boundaries: what to commission from the test-writer

  The generated law suite (`tests/generated/**`) covers what is true of *every*
  value object — that `parse` refuses `null`, `[]`, `42`, `""`, a `Date`, a
  `Symbol`; that equality is by value and not by reference; that parsing is
  deterministic. It is machine-generated from the contract by the pack's
  `value-object-laws.ts`, and
  `tests/generated/**` is write-denied for every role — the test-writer
  included — for the same reason the skeletons are: an edit to a generated file
  is a claim the next regeneration silently discards. It cannot cover the one
  thing that matters most: an input of
  the **right base type and the wrong value**. `"usd"` is a string. Only
  someone thinking about currencies knows it must fail.

  So the test-writer's brief must ask, per value object, for a
  `describe("<Name> — boundaries")` block containing at least one accepted
  literal and **at least two distinct rejected literals**.

  **Two is the floor, not the target.** Two forces a second axis — wrong case
  *and* wrong length — where one invites a token gesture. Ask for one per
  axis the rule actually has: `Currency` has case, length and character class,
  so four rejections are honest and two is the bare minimum. A value object
  whose rule has more axes than your block has rejections is under-tested, and
  no gate can tell you that — only the rule can, which is why the rule has to
  be written down (below).

  For the test-writer to choose these deliberately rather than guess, the rule
  must be visible to it: it reads the ticket's design note and the contract, nothing else.
  Give every value object a doc comment stating what makes it valid — and **two
  `@accepts` tags with distinct valid examples**:

  ```ts
  /** ISO-4217 alphabetic code: exactly three uppercase letters.
   * @accepts "USD"
   * @accepts "EUR"
   */
  export declare class Currency { … }
  ```

  The generated law suite needs one example to run its equality and
  determinism laws and a second, different one to run "equals discriminates".
  With one tag that law is emitted as a skip; Run 8 shipped with 9 skipped law
  tests for exactly this reason. Two tags costs you ten seconds at design time
  and buys a law per value object.

  Without it the test-writer invents a rule, the builder invents a different
  one, and they agree only by luck — the same failure as an unstated
  precondition order.

  **The parse boundary is the way out.** A raw primitive has to become a value
  object somewhere, and that somewhere is the value object's own `static parse`,
  which takes `unknown` — so the naked-primitive question never even arises for
  it:

  ```ts
  export declare class Isbn {
    private readonly __brand: "Isbn";
    private constructor();
    static parse(raw: unknown): Isbn | undefined;   // the boundary — takes unknown
  }
  ```

  This improves the design instead of suppressing the complaint: every primitive
  in the component funnels through one named, testable door — the value object's
  own constructor, reached only through `parse`. The brand and its only legal
  constructor belong together on the class, in the value object's own
  `*.contract.ts`. (`no-naked-primitives` also exempts a free function that
  *returns* a value object, but a free `parseIsbn(raw): Isbn` beside the `Isbn`
  class is refused by `value-objects-own-contract` and would scaffold to a
  `__brand` clash anyway — use the static `parse`.)

  What the rule deliberately leaves alone, so you can predict it: string-literal
  and template-literal unions (already value objects); `boolean`; `void` /
  `never` / `unknown`; type parameters and their constraints; type arguments of
  types it does not see through (`Result<string, E>`, `Brand<string, "Isbn">`);
  index-signature and `Record`/`Map` **key** positions; `declare class` bodies
  (a class is already nominal); anything not exported.
- **Encode cardinality in the type** where the requirement has one. No rule
  can infer this, so it is on you: "one or more authors" is
  `readonly [AuthorName, ...AuthorName[]]`, not `AuthorName[]` — an array
  silently permits empty, and a requirement no type carries is a requirement
  nothing checks.
- **Explicit types live here.** This is the framework level: annotate
  everything. Implementations will infer from these declarations.
- **Design for testability before you scaffold.** The test-writer works
  through this contract and nothing else — no implementation, nothing past
  the interface. Before running `scaffold-contract.ts`, check every exported
  operation against these; a failure means revise the contract, not the
  tests:
  1. **Single purpose** — one reason to exist, one behaviour to name.
  2. **Pure where possible** — output determined solely by input: no hidden
     state, no mutation of an argument, no reliance on module-level or global
     state.
  3. **Side effects are ports, not ambient calls** — time, IO, network,
     randomness, persistence each declared as an interface here and
     injected; never reached directly (`Date.now()`, a bare `fetch`, a
     module-level singleton).
  4. **Callable through the contract alone** — if testing an operation would
     need anything the interface doesn't expose, that's a design defect in
     the contract, not a gap in the tests.

## Escape hatches

The type checker is a harness layer, and `!`, `as`, `any` and `@ts-expect-error`
are the four ways to switch it off for one expression. Run 7 shipped a runtime
contract violation for exactly this reason: `tsc` rejected
`findInvoiceByOperationId(...)` as `Invoice | undefined`, and the builder wrote
`!` rather than handle the case. The gate had the bug and was overruled.

So `src/**` bans all four, with no exemption list:

- `@typescript-eslint/no-non-null-assertion`
- `@typescript-eslint/consistent-type-assertions` (`assertionStyle: "never"`)
- `@typescript-eslint/no-explicit-any`
- `@typescript-eslint/ban-ts-comment`
- `linterOptions.noInlineConfig: true` — so an `eslint-disable` comment cannot
  reopen any of them

The canonical value-object shape is what makes a blanket ban livable: with a
real constructor behind `parse`, a correct implementation needs none of the
four. If you find yourself reaching for one, the contract is usually wrong —
raise a `CONTRACT-DISPUTE` instead of asserting your way past it.

**There is no lint config in the target project to weaken.** `contract-purity`
builds its ESLint config programmatically and runs with
`overrideConfigFile: true`, so it consults no project config at all; the `src`
lint gate does the same. A worker cannot relax a rule by editing a file,
because there is no file — and an `eslint-disable` comment cannot either, because
`noInlineConfig` is part of the config it cannot reach.

## Worked example

The value object lives in its OWN contract file — a cohesive area of one:

```ts
// src/orders/order-id.contract.ts
/** A UUIDv4: lowercase hex, hyphenated 8-4-4-4-12, version nibble 4.
 * @accepts "3f2a1b64-9c1e-4a7d-8e55-0b1d2c3f4a5b"
 * @accepts "7d9e0c11-2b3a-4c5d-9e8f-1a2b3c4d5e6f"
 */
export declare class OrderId {
  private readonly __brand: "OrderId";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): OrderId | undefined;
  equals(other: OrderId): boolean;
}
```

The operations are a different area, and import each value object from its
IMPLEMENTATION module — one identity per value object (ADR 2026-023/026/027), and
the reason `value-objects-own-contract` refuses declaring `OrderId` here. Reach
the impl module, never the sibling `*.contract.ts`: `no-cross-contract-type-import`
refuses `import type { OrderId } from "./order-id.contract.js"` (and the matching
`export type … from`) at `contract_purity`, naming the impl specifier to use
instead — the contract's ambient `declare class` is a second `__brand` identity,
so importing it is the cross-file twin of the same-file clash:

```ts
// src/orders/orders.contract.ts
import type { OrderId } from "./order-id.js";     // its impl module, never .contract.js
import type { Money } from "../shared/money.js";  // Money's, likewise

export interface Order {
  id: OrderId;
  total: Money;
}

export type NewOrder = Omit<Order, "id">;

export interface OrderStore {
  save(order: Order): Promise<void>; // port — the impl injects a real store
}

export declare function createOrder(input: NewOrder): Order;
export declare function findOrder(id: OrderId): Order | undefined;
```

## After writing: gate, then scaffold

**If you are the architect in the developer-stage pipeline, you have no `bash`
and you do not need it.** Call `contract_purity` while you are still iterating
on a contract, and `design_gate` to advance the phase — it runs purity →
scaffold → typecheck → design-review → freeze in one call, so the scaffolder is
never something you invoke yourself. Everything below is the shell form of the
same scripts, for a session that is not bound to a pipeline role.

The scripts ship next to this skill, under `packs/ts/scripts/` — resolve them
from **this skill file's own directory** (shown in your session context):
`<skill-dir>/../../scripts/`. Run the deterministic checks yourself before
handing off; both fail with greppable one-line reasons, and iteration is
expected (the messages are instructions — read them):

```bash
SCRIPTS="<skill-dir>/../../scripts"   # e.g. .../packs/ts/scripts
node "$SCRIPTS/contract-purity.ts" "src/**/*.contract.ts"
node "$SCRIPTS/new-value-object.ts" src/orders/orders.contract.ts OrderId  # as the gate asks
node "$SCRIPTS/scaffold-contract.ts" src/orders/orders.contract.ts   # once per contract
npx tsc --noEmit
```

`contract-purity` exit codes: 0 clean · 1 problems listed · 2 no files matched
(treat 2 as an error — the gate must see the files). The scaffolder writes the
skeleton and auto-creates `src/shared/errors.ts` if missing.

A contract that lints clean, scaffolds, and typechecks is ready for the
test-writer.

## What the surface check asks of the implementation

`surface-check` compares each contract against its implementation as two sets,
and it asks a different question of types than of values:

- **Type-only exports are satisfied type-only.** An `export interface`, an
  `export type` (string-literal unions included) and the contract's own
  `export type { X } from` re-exports are satisfied by the scaffolded
  `export type * from "./x.contract.js"` line, by a type-only re-export of the
  name, or by a local declaration of it. They are never asked for a runtime
  export, because they have no value to export — demanding one is an impossible
  instruction, and r15 spent 4m19 and three worker bounces discovering that.
- **Value declarations need a reachable runtime export.** Classes, functions
  and `declare const`s must exist at runtime in the implementation, with the
  declared signature. A public export or a public member the contract does not
  declare is a violation in the other direction ("undeclared public surface");
  private and protected members are free.

So the `export type * from "./x.contract.js"` line the scaffolder writes into
every skeleton is load-bearing and must survive to delivery — `deliver` strips
the `__conformance` blob and leaves that re-export exactly where it is.

## API-service contracts (TN-26-004)

Three more purity rules apply the moment a contract describes a service
surface:

- **`no-erased-router`** (ts-service, when composed) — never declare the surface with a type-erased
  framework type (`AnyRouter`, `AnyProcedure`, …). A client typed against
  `AnyRouter` gets `unknown` inputs (dogfood r22 shipped exactly this). The
  router's type is *inferred* from the implementation, so re-export it — the
  same route ADR 2026-026 already sanctions for value objects:

  ```ts
  // src/api/api.contract.ts
  import type { serviceRouter } from "./api.js"; // the impl module
  export type ServiceRouter = typeof serviceRouter;
  ```

- **`router-type-reexported`** (contributed by the ts-service pack, so it
  applies when that pack is composed) — and those two lines are *required*, not
  optional. The moment a contract imports from `./service-runtime.js` it has
  declared itself a service, and a service with no re-exported router type
  gives the frontend nothing to type its client against. Omitting it is
  legal, silent, and costs exactly what erasing it costs: Run 23 delivered
  two services green with the type simply absent, and no gate objected. Now
  one does. (Borrowing the name from a sibling `*.contract.js`, or from the
  runtime module, does not count — the inferred type lives in the
  implementation module and nowhere else.)

- **`no-schema-on-surface`** — nothing from zod may appear in a contract, as
  an import, a type, or a re-export. The schema is the value object's
  internal engine (ADR 2026-031); the contract's whole validation surface is
  `static parse(raw: unknown): T | undefined`, exactly as for every other
  value object.

And one opt-in with a generated reward: a value object that crosses the wire
declares `toJSON(): <raw form>` — the exact shape its own `parse` accepts.
Declaring it adds the **round-trip law** to the generated suite
(`parse(toJSON(v)) ≡ v`, exercised through `JSON.stringify` as the transport
will), so serialization correctness is machine-tested, never remembered.
Landlocked domain types skip `toJSON` and skip the law.

## The guard log

Every gate and the scaffolder append to `.bounded/guard-log.jsonl` in the project —
blocks (where a guard caught drift) and passes (proof it ran). Don't edit it;
it's the after-the-fact record of where determinism did its job.
