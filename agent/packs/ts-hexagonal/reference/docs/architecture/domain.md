# Domain

The domain holds the business concepts and the rules they enforce. It has no I/O and knows nothing about storage, transport or frameworks.

## Organisation

```
domain/
  index.ts                     generated
  shared/result.ts             generated
  <area>/
    <concept>.contract.ts
    <concept>.ts
    <concept>.test.ts
    <concept>.laws.test.ts     generated
```

- Group by **business area** in plural (`items/`), never by technical role.
- The domain has **no feature level**: its concepts are shared by every feature in the area.
- `index.ts` re-exports the classes and, as types, every contract. It is generated from the contracts.

## Contracts own the name

Every domain concept is split into a **contract** and a hidden **implementation**, and the contract owns the concept's name. The implementation's skeleton, ending with the two exports below, is generated from the contract; only the class body is written by hand.

```
<concept>.contract.ts    interface <Name> + interface <Name>Factory   (pure: no implementation imports)
<concept>.ts             class <Name>Impl (not exported), then exports <Name> as both type and value
```

```ts
// item-title.contract.ts
import type { Result } from "../shared/result.ts";

export interface ItemTitle {             // the instance side
  readonly __brand: "ItemTitle";
  readonly value: string;
  equals(other: ItemTitle): boolean;
  toJSON(): string;
}

export interface ItemTitleFactory {      // the static side
  parse(raw: unknown): Result<ItemTitle>;
}
```

```ts
// item-title.ts
import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./item-title.contract.ts";

const schema = z.string().trim().min(1, "Item title is required");

class ItemTitleImpl implements Contract.ItemTitle {
  declare readonly __brand: "ItemTitle";
  private constructor(readonly value: string) {}

  static parse(raw: unknown): Result<ItemTitle> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new ItemTitleImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid item title" };
  }

  equals(other: ItemTitle): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type ItemTitle = Contract.ItemTitle;
export const ItemTitle: Contract.ItemTitleFactory = ItemTitleImpl;
```

Consumers import one name and use it both ways: `ItemTitle.parse(raw)` as a value and `title: ItemTitle` as a type.

Rules:

- **Contract files never import implementation files.** They import only other contract files and shared types such as `Result`.
- **The interface is named after the concept, with no suffix** (not `ItemTitleContract`, not `IItemTitle`). The static side is `<Name>Factory`, because TypeScript cannot put `static` members in an interface.
- **The implementation class is `<Name>Impl` and is never exported.** It exists in one file only.
- **The implementation file must end with the two exports** `export type <Name> = Contract.<Name>;` and `export const <Name>: Contract.<Name>Factory = <Name>Impl;`. The annotation on the `const` checks the static side against the factory. Import the contract as a namespace (`import type * as Contract`) so nothing is aliased.
- **`<Name>` means exactly one type everywhere,** the contract's interface. Never re-export the interface and the value from different files; always re-export the name from the implementation file.

## Value objects

A value object is an immutable, self-validating value. Two value objects are equal when their values are equal. Every value object **must** follow the pattern above, plus:

- **A `readonly __brand: "<Name>"` field in the interface**, declared (never assigned) in the class. It stops an object literal with matching fields from passing as the value object, unless someone deliberately writes the brand, which is as visible in review as an `as` cast.
- **Private constructor.** `parse` is the only way in, so an invalid value object cannot exist. The factory interface has no constructor signature.
- **`static parse(raw: unknown): Result<T>`.** Validation lives here. It returns the reason for failure; it never returns `undefined` and never throws for invalid input.
- **`equals`** compares by value. **`toJSON`** returns the plain form used on the wire.
- **Identifiers are value objects** too, and their factory also has `generate()`.
- `zod` is allowed in the domain.

## Entities

An entity has an identity that stays the same while its contents change. Entities follow the same contract-owns-the-name pattern:

```ts
// item.contract.ts
export interface Item {
  readonly __brand: "Item";
  readonly id: ItemId;
  readonly title: ItemTitle;
  equals(other: Item): boolean;
  toJSON(): { readonly id: string; readonly title: string };
}

export interface ItemFactory {
  new (id: ItemId, title: ItemTitle): Item;
}
```

- Built only from **already-valid value objects**, so the factory declares a public constructor signature and callers write `new Item(id, title)`.
- Equal **by identity**, not by content.
- Refers to entities in other areas **by their ID value object only**, never by holding the other entity.
- Business behaviour belongs on the entity or value object it concerns.

## Exports

`domain/index.ts` is generated. It re-exports each concept from its **implementation** file (giving both the type and the value) and each factory interface as a type:

```ts
export type { ItemTitleFactory } from "./items/item-title.contract.ts";
export { ItemTitle } from "./items/item-title.ts";
```

## No aggregates

This codebase follows "Kill Aggregate!" (Sara Pellegrini) and the Dynamic Consistency Boundary (DCB) approach:

- There are **no aggregate roots** and **no per-entity repositories**.
- Each feature (each decision) defines its own consistency boundary by declaring exactly the data it needs through its own out port (see [application.md](application.md#out-ports)).
- Domain folders are **business concepts**, not clusters guarded by a root.

## Domain services

Add a domain service only when a rule does not belong to any single concept. Most rules belong on a value object or entity.

## `Result`

`domain/shared/result.ts` (generated) defines the one result type used everywhere:

```ts
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };
```

It is named `Result`, not `ParseResult`, because every expected failure uses it. See [error-handling.md](error-handling.md).
