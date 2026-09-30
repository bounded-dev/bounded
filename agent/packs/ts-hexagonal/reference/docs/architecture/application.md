# Application

The application layer holds the **features** (use cases). It orchestrates the domain and declares, through ports, what it offers and what it needs. It performs no I/O itself.

## Organisation: vertical slices

```
application/
  index.ts                                 generated
  <area>/
    <feature>/
      <feature>.contract.ts                wire input, command, in port, out ports (types only)
      <feature>.command.ts                 generated from the contract, if the feature takes input
      <feature>.command.laws.test.ts       generated with the command
      <feature>.handler.ts                 the implementation
      <feature>.test.ts
      <feature>.store.test-support.ts      the store conformance suite, if the feature has a store
```

- Group by **business area** (plural), then by **feature**. There is no `features/`, `commands/`, `use-cases/` or `ports/` folder: everything for one feature lives together.
- A feature that involves more than one area lives in **whichever area the business would look for it in**. There is no rule about which concept "owns" it.
- `index.ts` exports commands, schemas and handlers, and exports contracts as types. It is generated.
- There is no `application/shared/` yet: a port that several features need is declared by each of them, because out ports are per feature.

## CQRS

- A **command** changes state (`create-item`, `archive-item`).
- A **query** reads state (`list-items`). A feature is a query when its verb is `count`, `find`, `get`, `list` or `search`.
- Each is its own feature with its own handler. A handler never both changes and returns unrelated read data.
- Sorting, filtering and paging that the UI does itself are not query parameters unless the server has to do them.

## Contracts

A feature's contract file describes the **whole** feature, and like every contract file it **never imports an implementation**. Its only import is the domain barrel, as types.

```ts
// create-item.contract.ts
import type { GroupId, Item, ItemTitle, Result } from "@<scope>/<context>/domain";

// Wire input: what callers send.
export interface CreateItemInput {
  readonly groupId: string;
  readonly title: string;
}

// Command: the input once validated into value objects.
export interface CreateItemCommand {
  readonly __brand: "CreateItemCommand";
  readonly groupId: GroupId;
  readonly title: ItemTitle;
}

export interface CreateItemCommandFactory {
  parse(raw: unknown): Result<CreateItemCommand>;
}

// In port: what this feature offers.
/**
 * Create an item in a group
 * @exposedVia trpc mcp
 */
export interface CreateItem {
  execute(command: CreateItemCommand): Promise<Result<Item>>;
}

// Out port: exactly what this feature needs.
export interface CreateItemStore {
  groupExists(id: GroupId): Promise<boolean>;
  save(item: Item): Promise<void>;
}
```

The shape is fixed so generators can read it:

- The one import is `import type { … } from "@<scope>/<context>/domain"`, names sorted, every name used.
- `<Feature>Input`, `<Feature>Command` and `<Feature>CommandFactory` come first, in that order, and are all present or all absent.
- `Input` fields are `readonly` and `string`, `number` or `boolean`. Optional and array fields are not supported yet.
- `Command` starts with its `__brand`, then the `Input` fields in the same order, each typed by a value object or identifier.
- Then the in port, then the out ports.

### In ports

- One interface per feature, named after the feature, with a single `execute` method.
- `execute` takes the command (or nothing, for a query or a trigger with no input).
- It returns a `Result` when the feature has an expected business failure; otherwise it returns the value directly. The value is `void`, one domain concept or an array of one.
- `@exposedVia <tech> …` in the `/** */` block directly above it names the in-adapter technologies that expose the feature (`trpc`, `mcp`, `lambda`). Without it the feature has no in adapter. The block's first lines are the feature's summary; an MCP tool uses it as its description, so it is required with `mcp`.

### Out ports

- **Declared by the feature that needs them,** in its own contract file. Never shared between features, **even when two are identical today**, because they will diverge.
- Contain only what this feature needs, in the feature's language. There is no general-purpose repository. Every method returns a `Promise`.
- Named exactly `<Feature>Store` for storage, and a feature has at most one. It is implemented once for every storage technology the project uses.
- For other capabilities, name what they do (`ItemExporter`, `ItemSummarizer`) and tag the port with `@implementedBy <tech>` (`console`, or a real technology) in the `/** */` block directly above it.
- A feature may have several out ports, one per capability. Their declaration order is the handler's constructor order, and no two may end in the same word.

## Commands

A command is the validated input to a feature. It **holds value objects, not raw primitives**. Its contract (`<Feature>Command`, `<Feature>CommandFactory`) and its wire input (`<Feature>Input`) are declared in the feature's contract file. The command file is **generated** from them, with the same contract-owns-the-name pattern as the domain (see [domain.md](domain.md#contracts-own-the-name)):

```ts
// create-item.command.ts (generated)
import { z } from "zod";
import { GroupId, ItemTitle, type Result } from "@<scope>/<context>/domain";
import type * as Contract from "./create-item.contract.ts";

// Wire contract: tRPC and MCP use this for their input types.
export const createItemSchema = z.object({
  groupId: z.string(),
  title: z.string(),
}) satisfies z.ZodType<Contract.CreateItemInput>;

class CreateItemCommandImpl implements Contract.CreateItemCommand {
  declare readonly __brand: "CreateItemCommand";
  private constructor(
    readonly groupId: GroupId,
    readonly title: ItemTitle,
  ) {}

  static parse(raw: unknown): Result<CreateItemCommand> {
    const input = createItemSchema.safeParse(raw);
    if (!input.success) return { ok: false, error: "Invalid create item input" };
    const groupId = GroupId.parse(input.data.groupId);
    if (!groupId.ok) return groupId;
    const title = ItemTitle.parse(input.data.title);
    return title.ok ? { ok: true, value: new CreateItemCommandImpl(groupId.value, title.value) } : title;
  }
}

export type CreateItemCommand = Contract.CreateItemCommand;
export const CreateItemCommand: Contract.CreateItemCommandFactory = CreateItemCommandImpl;
```

- **`<Feature>Input`** (contract) is the wire shape: plain strings, numbers and booleans.
- **`<feature>Schema`** is its runtime zod schema, which in adapters pass to their framework so clients get typed input. The `satisfies z.ZodType<Contract.<Feature>Input>` line fails compilation if the schema drifts from the contract.
- **`static parse`** turns raw input into value objects, field by field in declaration order, and returns the first failure unchanged. A handler only ever receives valid domain types.
- `<feature>.command.laws.test.ts` is generated with it and proves exactly that, whatever the value objects accept.
- A feature without input has no command file and no `Input` or `Command` in its contract.

## Handlers

```ts
// create-item.handler.ts
export class CreateItemHandler implements CreateItem {
  constructor(private readonly store: CreateItemStore) {}

  async execute(command: CreateItemCommand): Promise<Result<Item>> {
    if (!(await this.store.groupExists(command.groupId))) {
      return { ok: false, error: "Group not found" };
    }
    const item = new Item(ItemId.generate(), command.groupId, command.title);
    await this.store.save(item);
    return { ok: true, value: item };
  }
}
```

- A class named `<Feature>Handler` that `implements` the in port. It imports its types from its own contract file, never from the command file.
- Its skeleton is generated: the constructor takes every out port in declaration order as `private readonly <role>: <Port>`, where the role is the last word of the port's name (`store`, `exporter`). Tests construct it the same way: `new CreateItemHandler(fakeStore)`.
- Handlers are exported directly: the in port already owns the feature name, and only composition roots construct handlers.
- One public method: `execute`. Helpers are private.
- No formats (CSV, JSON), no destinations (S3, disk), no transport concerns. Those belong in adapters.
- Handlers are "application services". There is no separate service layer.
