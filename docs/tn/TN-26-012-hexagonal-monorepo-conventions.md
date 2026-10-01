---
number: TN-26-012
title: Hexagonal monorepo conventions — the names, shapes and files every generator agrees on
kind: design
status: active
issue: (pending)
---

# TN-26-012: Hexagonal monorepo conventions

A TypeScript project built by the harness has the layout of the worked
example: a Bun monorepo in which each bounded context and each app is its own
package, and each context is split into hexagonal layers (domain,
application, adapters). The example's own rulebook (its
`docs/architecture/*.md`, shipped by `ts-hexagonal`) says how people write
it. This note says what the **generators, gates and lint rules** rely on: the
names they derive, the contract shapes they parse, and which files are
generated, skeleton or role-authored. Every rule below is deterministic;
where the example leaves a choice open, this note makes it.

Decisions are in ADRs 2026-056 to 2026-064. Throughout, `C` stands for
`contexts/<context>/src`, `<scope>` for the package scope with its `@`
(`@example`), and names in angle brackets are kebab-case unless the rule
says otherwise. The derivation functions are in
`agent/packs/ts/scripts/naming.ts`. The parsed contract model is in
`agent/packs/ts/scripts/feature-model.ts`.

## 1. Layout

```
package.json  tsconfig.base.json  tsconfig.json  bun.lock      config (ADR 2026-054)
architecture.test.ts                                            generated
docker-compose.yml  .env.example                                config (ts-drizzle-postgres)
docs/architecture/*.md                                          generated (ts-hexagonal)
contexts/<context>/
  package.json                                                  config
  drizzle.config.ts                                             generated (ts-drizzle-postgres)
  src/                                                          source root
    domain/index.ts                                             generated
    domain/shared/result.ts                                     generated
    domain/shared/errors.ts                                     generated, red phase only
    domain/<area>/<concept>.contract.ts                         architect
    domain/<area>/<concept>.ts                                  skeleton → builder
    application/index.ts                                        generated
    application/<area>/<feature>/<feature>.contract.ts          architect
    application/<area>/<feature>/<feature>.command.ts           generated (iff Input)
    application/<area>/<feature>/<feature>.handler.ts           skeleton → builder
    adapters/in/<tech>/**                                       generated
    adapters/out/<tech>/index.ts                                generated
    adapters/out/<tech>/<tech>-database.ts                      storage techs: see §7
    adapters/out/<tech>/<area>/<feature>.<role>.ts              skeleton → builder
    adapters/out/<tech>/<area>/<concept>.mapper.ts              builder
    adapters/out/drizzle/schema/<context>.schema.ts             generated
    adapters/out/drizzle/schema/<area>.ts                       skeleton → builder
    adapters/out/drizzle/migrations/**                          generated
apps/<app>/
  package.json                                                  config
  src/                                                          source root
    [server/|main/]composition-root.ts                          skeleton → builder
    <entry files>                                               per workspace template
```

Source roots (ADR 2026-056) are `contexts/*/src` and `apps/*/src`. A
workspace directory is its source root's parent; its package name is
`<scope>/<last segment>`.

## 2. Naming

| Thing | Rule | Example |
|---|---|---|
| Files, folders | kebab-case | `note-text.ts` |
| Context | kebab-case directory under `contexts/` | `project-management` |
| Area | plural business noun | `notes`, `order-lines` |
| Feature | verb-first, kebab-case, at least two words | `create-note`, `list-notes` |
| Domain concept file stem | kebab-case of the concept name | `NoteText` → `note-text` |
| Domain interface / factory / class | `<Name>`, `<Name>Factory`, `<Name>Impl` (unexported) | `NoteText` |
| In port | `pascal(feature)` | `CreateNote` |
| Wire input | `<InPort>Input` | `CreateNoteInput` |
| Command | `<InPort>Command`, `<InPort>CommandFactory`, class `<InPort>CommandImpl` (unexported) | `CreateNoteCommand` |
| Wire schema | `camel(feature)Schema` | `createNoteSchema` |
| Store out port | exactly `<InPort>Store`; at most one per feature | `CreateNoteStore` |
| Other out port | names its capability; must not end in `Store` | `ProjectExporter` |
| Port role | last word of the port name, lowercased (`portRole`) | `store`, `exporter` |
| Handler | `<InPort>Handler` in `<feature>.handler.ts` | `CreateNoteHandler` |
| Adapter class prefix | `pascal(tech id)` (`adapterClassPrefix`) | `InMemory`, `Drizzle`, `Console` |
| Out-adapter class | `<Prefix><Port>` in `<feature>.<role>.ts` | `InMemoryCreateNoteStore`, `ConsoleProjectExporter` |
| Storage database | `<Prefix>Database` in `<tech>-database.ts` | `InMemoryDatabase` |
| Composition dependency key | `camel(feature)` | `createNote` |
| Package | `<scope>/<workspace dir name>` | `@example/project-management` |
| Package export | `./domain`, `./application`, `./adapters/<tech>` | `./adapters/in-memory` |
| CQRS kind | `query` when the first word is `count`, `find`, `get`, `list` or `search`; otherwise `command` (`featureKind`) | `list-notes` is a query |

`pascal`, `camel` and `snake` convert kebab-case (`pascalCase`,
`camelCase`, `snakeCase`). A name outside this grammar is refused, never
guessed.

## 3. Contract shapes

### Domain concept (`C/domain/<area>/<concept>.contract.ts`)

As the example's `domain.md` (ADR 2026-059). The kind is read from the
factory:

| Kind | Factory members | Instance members |
|---|---|---|
| value object | `parse(raw: unknown): Result<Name>` | `__brand`, `value`, `equals`, `toJSON` |
| identifier | `generate(): Name`, `parse(raw: unknown): Result<Name>` | as value object |
| entity | `new (...valueObjects): Name` | `__brand`, id and value-object fields, `equals`, `toJSON` |

Domain contracts import only other contracts (relative paths) and
`../shared/result.ts`, always with `import type`.

### Feature (`C/application/<area>/<feature>/<feature>.contract.ts`)

This is the example's `create-note.contract.ts` with the tags of §4 added:

```ts
import type { Note, NoteText, ProjectId, Result } from "@example/project-management/domain";

// Wire input: what callers send.
export interface CreateNoteInput {
  readonly projectId: string;
  readonly text: string;
}

// Command: the input once validated into value objects.
export interface CreateNoteCommand {
  readonly __brand: "CreateNoteCommand";
  readonly projectId: ProjectId;
  readonly text: NoteText;
}

export interface CreateNoteCommandFactory {
  parse(raw: unknown): Result<CreateNoteCommand>;
}

// In port: what this feature offers.
/**
 * Create a note
 * @exposedVia trpc
 */
export interface CreateNote {
  execute(command: CreateNoteCommand): Promise<Result<Note>>;
}

// Out port: exactly what this feature needs.
export interface CreateNoteStore {
  projectExists(id: ProjectId): Promise<boolean>;
  save(note: Note): Promise<void>;
}
```

Rules the parser (WI-5) enforces, refusing anything else with the contract
path and the fix:

- One import: `import type { … } from "<scope>/<context>/domain"`, names
  sorted, `Result` included when used (Q3). No other import.
- `Input`, `Command` and `CommandFactory` are all present or all absent.
  Present means the feature takes input and gets a generated command file.
- `Input` fields are `readonly <name>: string | number | boolean`. Optional
  and array fields are refused for now.
- `Command` is `readonly __brand: "<InPort>Command"` then the same field
  names as `Input`, in the same order, each typed by a value object or
  identifier whose factory has `parse`.
- `CommandFactory` is exactly `parse(raw: unknown): Result<<InPort>Command>`.
- The in port has exactly `execute`. It takes `(command: <InPort>Command)`
  when the feature takes input, else nothing. It returns
  `Promise<R>` or `Promise<Result<R>>`, where `R` is `void`, a concept, or
  a concept array (`ReturnModel`).
- Out ports follow the in port. Every method returns a `Promise`. Their
  declaration order is the handler's constructor order. Two out ports with
  the same role are refused, because their constructor parameters would
  share a name.
- The `//` comments are conventional and optional. They carry no meaning.

## 4. Tags

Three JSDoc tags carry meaning; contract lint allows them and no other tag has
semantics. A tag lives in the `/** … */` block directly above the interface
it describes.

```
exposed    = "@exposedVia"    1*( SP tech-id )      ; on the in port only
implemented = "@implementedBy" 1*( SP tech-id )     ; on a non-store out port only
accepts    = "@accepts" SP literal                  ; on a value object's or identifier's interface
tech-id    = kebab-case id of a composed adapter technology
literal    = a TypeScript literal of the value's primitive type ("Website relaunch", 42)
```

`@accepts` (ADR 2026-059, rule `bounded-ts/value-object-documented`): every
value object and every identifier carries a doc comment stating its validity
rule and at least two `@accepts` lines, one tag per line, whose literals
differ after trimming. They are the valid samples the generated laws
(`<concept>.laws.test.ts`) parse; without them the laws of `equals` and
`parse` would have nothing to run on. An identifier's equality laws sample
`generate()`, but its examples are still required: they are the only valid
wire form the blind test-writer can see, and its `<Name> — boundaries` block
(§8) needs an accepted literal. The laws check `parse` accepts them. Example:

```ts
/**
 * The name of a project: not empty once trimmed.
 * @accepts "Website relaunch"
 * @accepts "Office move"
 */
export interface ProjectName { … }
```

The worked example's own value objects and identifiers carry no `@accepts`
yet; the harness's reference copy adds them (see `agent/packs/ts/reference/README.md`).

- The tag line is `^\s*\*\s*@exposedVia(\s+[a-z][a-z0-9]*(-[a-z0-9]+)*)+\s*$`
  (likewise `@implementedBy`). At most one tag of each kind per interface.
  Ids are unique within a tag.
- `@exposedVia` ids must be composed adapter technologies with direction
  `in`. Absent means the feature has no in adapter. That is legal, and the
  obligations gate decides whether it is useful.
- `@implementedBy` is required on every out port that is not the store,
  refused on the store, and its ids must be composed `out` technologies with
  `storage: false`. A store is implemented once per composed storage
  technology, without a tag.
- The block's summary is its text before the first tag: lines joined with
  single spaces, trimmed. It becomes `doc` in the model. When `mcp` is in
  `@exposedVia`, a non-empty in-port summary is required: it is the tool
  description.

The example's five features carry: `create-note` `trpc`; `list-notes`
`trpc`; `create-project` `trpc mcp`; `list-projects` `trpc mcp`;
`export-projects` `lambda`, with `ProjectExporter` tagged
`@implementedBy console`.

## 5. Handlers, stores and other out adapters

**Handler** (`<feature>.handler.ts`, skeleton):

```ts
import type { Note, Result } from "@example/project-management/domain";
import { NotImplementedError } from "../../../domain/shared/errors.ts";
import type { CreateNote, CreateNoteCommand, CreateNoteStore } from "./create-note.contract.ts";

export class CreateNoteHandler implements CreateNote {
  constructor(private readonly store: CreateNoteStore) {}

  async execute(command: CreateNoteCommand): Promise<Result<Note>> {
    throw new NotImplementedError("CreateNoteHandler.execute");
  }
}
```

- The constructor takes every out port in declaration order, as
  `private readonly <role>: <Port>`. With two or more, each goes on its own
  line (example: `export-projects.handler.ts` takes `store`, then
  `exporter`).
- The only public member besides the constructor is `execute`. Its signature
  is copied from the in port, marked `async`. Types come from the feature's
  own contract and the domain barrel, never from the command file.
- Tests construct handlers as `new <InPort>Handler(fakePort, …)`, in the
  same order.

**Store** (`adapters/out/<tech>/<area>/<feature>.store.ts`, skeleton, one per
composed storage technology):

```ts
import type { CreateNoteStore } from "@example/project-management/application";
import type { Note, ProjectId } from "@example/project-management/domain";
import { NotImplementedError } from "../../../../domain/shared/errors.ts";
import type { InMemoryDatabase } from "../in-memory-database.ts";

export class InMemoryCreateNoteStore implements CreateNoteStore {
  constructor(private readonly db: InMemoryDatabase) {}

  async projectExists(id: ProjectId): Promise<boolean> {
    throw new NotImplementedError("InMemoryCreateNoteStore.projectExists");
  }

  async save(note: Note): Promise<void> {
    throw new NotImplementedError("InMemoryCreateNoteStore.save");
  }
}
```

- The constructor is exactly `(private readonly db: <Prefix>Database)`.
  The composition root and store tests pass the shared database object.
- `InMemoryDatabase` has a no-argument constructor. Its skeleton is
  `export class InMemoryDatabase {}`, and the builder adds fields.
  `DrizzleDatabase` is a generated type alias over Drizzle's generic Postgres
  database (WI-6).

**Other out adapter** (`adapters/out/<tech>/<area>/<feature>.<role>.ts`,
skeleton, one per `@implementedBy` id): `export class <Prefix><Port>
implements <Port>` with no constructor and every port method, marked `async`,
throwing `NotImplementedError("<Class>.<method>")`. Example:
`ConsoleProjectExporter` in `out/console/projects/export-projects.exporter.ts`.

**Not-implemented module** (`C/domain/shared/errors.ts`, generated, emitted
at `design` and `red` only; delivery removes it and refuses while anything
imports it):

```ts
// Generated for the red phase; delivery removes it.
export class NotImplementedError extends Error {
  constructor(member: string) {
    super(`Not implemented: ${member}`);
    this.name = "NotImplementedError";
  }
}
```

Skeletons import it by relative path, because it is not in the domain
barrel.

## 6. In adapters (generated)

Only features whose in port names the technology in `@exposedVia` get files.
Deps objects list features sorted by area, then feature. File lists and
barrels are sorted by path.

### Route keys: `routeKey(area, feature)`

Take the feature's words, remove the first occurrence (from the second word
on) of the area noun, and camelCase the rest. The area noun is the area's
words, and its last word may be singular (`+s`, `+es` or `y`→`ies`). With no
occurrence, the key is the whole feature camelCased. Checked against the
example:

| Area / feature | Key | Example file |
|---|---|---|
| `notes/create-note` | `create` | `in/trpc/notes/notes.router.ts`: `create: createNoteProcedure(deps.createNote)` |
| `notes/list-notes` | `list` | same file: `list: listNotesProcedure(deps.listNotes)` |
| `projects/create-project` | `create` | `in/trpc/projects/projects.router.ts` |
| `projects/list-projects` | `list` | same file |
| `notes/add-note-tag` | `addTag` | (rule only) |
| `order-lines/create-order-line` | `create` | (rule only) |

Two features with one key in an area are refused at the design gate.

### tRPC (`ts-trpc`, feature role `procedure`)

| File | Content |
|---|---|
| `in/trpc/trpc.ts` | `export const t = initTRPC.create();` (the one instance) |
| `in/trpc/<area>/<feature>.procedure.ts` | `export const <camel(feature)>Procedure = (<camel(feature)>: <InPort>) => t.procedure[.input(<schema>)].<mutation for command, query for query>(…)` |
| `in/trpc/<area>/<area>.router.ts` | `export function create<pascal(area)>Router(deps: { <camel(feature)>: <InPort>; … })` returning `t.router({ <routeKey>: <camel(feature)>Procedure(deps.<camel(feature)>), … })` |
| `in/trpc/router.ts` | `type Deps = Parameters<typeof create<Area>Router>[0] & …`; `export function create<pascal(context)>Router(deps: Deps)` returning `t.router({ <camel(area)>: create<Area>Router(deps), … })`; `export type <pascal(context)>Router = ReturnType<typeof create<pascal(context)>Router>;` |
| `in/trpc/index.ts` | `export { create<Ctx>Router, type <Ctx>Router } from "./router.ts";` |

Procedure bodies follow the example exactly: parse with
`<InPort>Command.parse(input)`, and when `!command.ok` return `command`.
Then call `execute` and return `toJSON()` data. A `Result` return maps to
`result.ok ? { ok: true as const, value: result.value.toJSON() } : result`.
A plain concept return maps to `{ ok: true as const, value: <x>.toJSON() }`.
An array return maps to `.map((<camel(concept)>) => <camel(concept)>.toJSON())`.
The remaining combinations (WI-7), where `R` is the in port's result:

| Input | `R` | tRPC / Lambda answer | MCP answer |
|---|---|---|---|
| yes | `void` | `{ ok: true as const, value: undefined }` | `{ content: [] }` |
| yes | `C[]` | `{ ok: true as const, value: cs.map((c) => c.toJSON()) }` | `JSON.stringify(cs)` |
| yes | `Result<void>` | the Result as returned | failure → `isError`; success → `{ content: [] }` |
| no | `C` / `C[]` | `(await p.execute()).toJSON()` / `.map(…)` | `JSON.stringify(…)` |
| no | `void` | nothing | `{ content: [] }` |
| no | `Result<C>` / `Result<C[]>` | mapped as with input | failure → `isError`; success → `JSON.stringify(result.value)` |

A command failure is returned as-is by tRPC and Lambda and as `isError` by
MCP. The array local is the concept's plural (`projects`).

### MCP (`ts-mcp`, feature role `tool`)

| File | Content |
|---|---|
| `in/mcp/<area>/<feature>.tool.ts` | `export function register<InPort>Tool(server: McpServer, <camel(feature)>: <InPort>): void` calling `server.registerTool("<snake(feature)>", { description: "<in-port summary>"[, inputSchema: <schema>.shape] }, …)`. Failures return `isError: true`. |
| `in/mcp/server.ts` | `export function create<pascal(context)>McpServer(deps: { … })` builds `new McpServer({ name: "<context>", version: "0.1.0" })` and registers each tool |
| `in/mcp/index.ts` | `export { create<Ctx>McpServer } from "./server.ts";` |

Tool names are `toolName(feature)` = `snake(feature)`: `create_project`,
`list_projects`, as in the example.

### Lambda (`ts-lambda`, feature role `lambda`)

| File | Content |
|---|---|
| `in/lambda/<area>/<feature>.lambda.ts` | `export const create<InPort>Lambda = (<camel(feature)>: <InPort>) => async (): Promise<void> => { await <camel(feature)>.execute(); };` (for an input-less `void` feature, as `export-projects`; a feature with input takes `(event: unknown)`, parses it with its command and answers as a tRPC procedure does) |
| `in/lambda/index.ts` | one `export { create<InPort>Lambda } from "./<area>/<feature>.lambda.ts";` per feature |

### Barrels (generated by `ts-hexagonal`)

- `C/domain/index.ts`: `export type { Result } from "./shared/result.ts";`,
  a blank line, then per area (sorted, blank line between): the
  `export type { <Name>Factory }` lines, then the `export { <Name> }`
  lines, each sorted by concept name.
- `C/application/index.ts`: per feature (sorted by area, then feature;
  blank line between): `export type { … }` of the in port, `CommandFactory`,
  `Input` and out ports, sorted by name. Then
  `export { <InPort>Command, <schema> }` from the command file (iff input),
  then `export { <InPort>Handler }`.
- `C/adapters/out/<tech>/index.ts`: for a storage technology,
  `export { <Prefix>Database } from "./<tech>-database.ts";` first. Then one
  export per adapter class, sorted by area, then feature.

A one-line comment at the top of a barrel is allowed. Emitters print with
one fixed layout: two-space indent, double quotes, semicolons, trailing
commas in multi-line lists, width 120. Comparisons with the example
normalise whitespace, line breaks and comments.

### Command file (`<feature>.command.ts`, generated)

It has the same shape as the example's `create-note.command.ts`:
`import { z } from "zod"`, the value objects plus `type Result` from the
domain barrel, and `import type * as Contract`. Then
`export const <schema> = z.object({ <field>: z.<wireType>(), … }) satisfies z.ZodType<Contract.<InPort>Input>;`,
then the unexported `<InPort>CommandImpl` with a private constructor of
`readonly` fields and `static parse`, which parses each field through
`<Concept>.parse` in order and returns the first failure. It ends with the
two-export tail. The input error message is `Invalid <feature words> input`.

## 7. Generated, skeleton and authored files

**Generated** (mode `generated`; write-denied, readable by all, drift-checked).
The globs are the `generatedFileGlobs` each pack contributes:

| Glob | Pack | Item |
|---|---|---|
| `**/*.laws.test.ts` | ts | WI-3/WI-4 |
| `architecture.test.ts` | ts-hexagonal | WI-5 |
| `docs/architecture/**` | ts-hexagonal | WI-5 |
| `contexts/*/src/domain/index.ts` | ts-hexagonal | WI-5 |
| `contexts/*/src/domain/shared/result.ts` | ts-hexagonal | WI-5 |
| `contexts/*/src/domain/shared/errors.ts` | ts-hexagonal | WI-5 |
| `contexts/*/src/application/index.ts` | ts-hexagonal | WI-5 |
| `contexts/*/src/application/*/*/*.command.ts` | ts-hexagonal | WI-5 |
| `contexts/*/src/adapters/out/*/index.ts` | ts-hexagonal | WI-5 |
| `contexts/*/src/adapters/in/trpc/**` | ts-trpc | WI-7 |
| `contexts/*/src/adapters/in/mcp/**` | ts-mcp | WI-7 |
| `contexts/*/src/adapters/in/lambda/**` | ts-lambda | WI-7 |
| `contexts/*/drizzle.config.ts` | ts-drizzle-postgres | WI-6 |
| `contexts/*/src/adapters/out/drizzle/drizzle-database.ts` | ts-drizzle-postgres | WI-6 |
| `contexts/*/src/adapters/out/drizzle/schema/*.schema.ts` | ts-drizzle-postgres | WI-6 |
| `contexts/*/src/adapters/out/drizzle/migrations/**` | ts-drizzle-postgres | WI-6 |
| `contexts/*/src/adapters/out/drizzle/drizzle-test-database.test-support.ts` | ts-drizzle-postgres | WI-6 |

Generated laws include `<concept>.laws.test.ts`,
`<feature>.command.laws.test.ts` and the in-adapter laws
`in/<tech>/<area>/<feature>.<role>.laws.test.ts`. Manifests, `tsconfig*`
and `bun.lock` are generated **config** (ADR 2026-054), protected by the
config-name sockets rather than these globs.

A context's `drizzle.config.ts` is an emitted, generated file, not config:
it depends on the context's name, which only the emitters see. It is the
worked example's config plus one line,
`migrations: { schema: "drizzle", table: "__drizzle_migrations_<snake(context)>" }`.
Drizzle's migrator applies only migrations newer than the latest row in its
table, so contexts sharing one database and one table would skip each
other's migrations. The generated store-test support migrates into the same
per-context table.

**Skeleton** (mode `skeleton`; written only where absent, then the builder's):

| Path | Pack |
|---|---|
| `C/domain/<area>/<concept>.ts` | ts (WI-3) |
| `C/application/<area>/<feature>/<feature>.handler.ts` | ts-hexagonal |
| `C/adapters/out/in-memory/in-memory-database.ts` | ts-hexagonal |
| `C/adapters/out/in-memory/<area>/<feature>.store.ts` | ts-hexagonal |
| `C/adapters/out/<tech>/<area>/<feature>.<role>.ts` for `@implementedBy` ids | ts-hexagonal |
| `C/adapters/out/drizzle/<area>/<feature>.store.ts` | ts-drizzle-postgres |
| `C/adapters/out/drizzle/schema/<area>.ts` | ts-drizzle-postgres |
| `apps/<app>/src/**/composition-root.ts` and other template files marked `skeleton` | the app's template pack |

**Authored by roles:**

| Role | Files |
|---|---|
| architect | `*.contract.ts` under a source root; TN front matter |
| test-writer | test-side files (§8) that no generated glob matches |
| builder | every other file under a source root that no generated glob matches: skeleton bodies, `*.mapper.ts`, composition roots |

## 8. Test side

`testFileSuffixes`: `.test.ts`, `.test.tsx`, `.test-support.ts` (the ts
pack's contribution). A file under a source root is test-side when its name
ends with one of these and no generated glob matches it. Matching ignores
case. The test-writer authors:

| Level | Path |
|---|---|
| Domain unit | `C/domain/<area>/<concept>.test.ts` |
| Handler | `C/application/<area>/<feature>/<feature>.test.ts`, with fakes of the feature's out ports inline |
| Store conformance suite | `C/application/<area>/<feature>/<feature>.store.test-support.ts`, which exports a suite that takes a factory for the store under test |
| Store, per storage technology | `C/adapters/out/<tech>/<area>/<feature>.store.test.ts`, running the conformance suite |
| Other out adapter | `C/adapters/out/<tech>/<area>/<feature>.<role>.test.ts` |
| App smoke | `apps/<app>/src/**/composition-root.test.ts` next to the composition root, against `compose<Entry>()`; run at green only (Q2) |

The in-adapter level is generated laws only. The test-writer writes nothing
under `adapters/in/`, which is generated. Store tests follow ADR 2026-064:
skipped with a logged reason at red without a container runtime, and a
refusal at green. Before green (and mutation score, and deliver's check)
runs any test, store tests' Testcontainers must start and stop one
container from the pinned image; if it cannot, green refuses with the
cause and a remedy, routed to the orchestrator. A store test that still
fails for a recognised machine cause (credential helper, registry, socket,
reaper) routes to the orchestrator too, never to the builder.

What each gate runs. The red gate runs the test-side files of the
workspaces that hold contracts (the contexts), in a shadow rebuilt from the
contracts, those tests, the generated files and the config, with every
emitter re-run at phase `red`. A generated law may pass there, because it
also exercises generated code; a hand-written test must fail with
`NotImplementedError`. An app's tests and root-level test files (the
architecture test) run at green only. Green is bound to a hash of every
test-side file under every source root that no generated glob matches
(`testFilesHash`), so editing or adding any of them voids it, and green
refuses any skipped or todo result.

The obligations each level owes (`testObligations`): every concept has its
laws, a `<concept>.test.ts` and a `<Name> — boundaries` block per value
object and identifier, asserted on the `Result` (`expect(X.parse(v).ok)
.toBe(true|false)` or `toEqual({ ok: …, … })`), with one accepted literal
and two distinct rejected literals of its base type; every factory member
and instance method is called. Every feature has `<feature>.test.ts`
constructing `<InPort>Handler` and calling `execute`; a store port has its
conformance suite calling every method and one store test per composed
storage technology importing it; every other out port has a test per
`@implementedBy` technology; generated command and in-adapter laws exist.
Every app has `composition-root.test.ts` beside each composition root
(green only). With ts-drizzle-postgres composed, composition roots connect to
`process.env.DATABASE_URL`; at green its phase test policy starts one
throwaway Postgres from the pinned image, applies every context's migrations,
sets `DATABASE_URL` for the run over any inherited value, and removes the
container after the run, failed or not (the policy's `prepare`, a
`PreparedTestService` the gate releases). Without a container runtime a
project persisting through Drizzle is refused at green.

## 9. TN `workspaces:` front matter

Apps are declared in a ticket TN's front matter, in block form only:

```yaml
workspaces:
  apps/web: web
  apps/mcp: mcp
```

- Core shape (WI-2, `agent/src/ticket-design.ts`): after a line exactly
  `workspaces:`, each following indented line must match
  `^  ([a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)*): ([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$`.
  Keys are distinct. The block ends at the first unindented line. Absent
  means no workspaces; a bare `workspaces:` means an empty map. Anything
  else makes the note invalid.
- Pack meaning (WI-4): the value is a composed `workspaceTemplates` kind,
  and the key is `<that template's root>/<name>`. The context kind is
  refused, because contexts come from contract paths. Maps from several TNs
  are merged, and one directory with two kinds is refused.

## 10. Socket reference

| Socket | Kind | Owner, file | Shape |
|---|---|---|---|
| `sourceRoots` | data | core, `agent/src/pack-contrib.ts` | `string[]`; `sourceRoots(cwd)`, `sourceRootsFor(packs)`, `sourceRootsOrUnreadable(cwd)`, `sourceRootOf(path, roots)` |
| `testFileSuffixes` | data | core, same file | `string[]`; `testFileSuffixes(cwd)`, `testFileSuffixesFor(packs)`, `testFileSuffixesOrUnreadable(cwd)`, `hasTestFileSuffix(path, suffixes)` |
| `generatedFileGlobs` | data | core, same file | `string[]`; `generatedFileGlobs(cwd)`, `generatedFileGlobsFor(packs)`, `generatedFileGlobsOrUnreadable(cwd)`, `pathGlobMatcher(globs)` |
| `skeletonEmitters` | code | ts, `agent/packs/ts/pack.ts` | `Emitter { name; description; emit(facts: ProjectFacts): readonly EmittedFile[] }`, `EmittedFile { path; content; mode }`, `emittedFileProblem(file, emitter)` |
| `adapterTechnologies` | data | ts, same file | contrib entry `{ id, direction: "in"\|"out", description, featureRole? (in), storage? (out), pins?, workspaceScripts? }`; read with `adapterTechnologies(packs)` → `AdapterTechnology[]` |
| `workspaceTemplates` | data | ts, same file | contrib `{ <kind>: { root, manifest, description, files?: { <path>: { source, mode } } } }`; read with `workspaceTemplates(packs)` → `WorkspaceTemplate[]` |
| `phaseTestPolicies` | code | ts, same file | `PhaseTestPolicy { name; description; decide({ project, phase: "red" \| "green" }) → run (prepare?, infrastructureFailure?) \| skip (red: env, unsetEnv, skippedTest) \| refuse (green) }`; ts-drizzle-postgres contributes the store-test rule (ADR 2026-064) |
| `testObligations` | code | ts, same file | `TestObligation { name; description; phases?; check(input) → ObligationGap[] }` over the facts, the source-root files and the test-side sources; ts-hexagonal contributes the feature, store, out-adapter, in-adapter-laws and app levels (ADR 2026-063) |
| `tnExampleContracts` | data | core, `agent/src/project-init.ts` | `string[]`: contract paths (placeholders allowed) `bounded init` shows in `docs/tn/README.md`; each must lie under a composed source root and end with a composed contract suffix. ts-hexagonal names a concept and a feature |
| `tnExampleWorkspaces` | data | core, same file | `{ <dir>: <kind> }`: the apps shown in that README's example `workspaces:` block; each app pack names its own |

`bounded init` with no `--pack` selects the explicit list in
`agent/packs/default-stack.json` (the whole stack). A pack with nothing to
scaffold at init declares `"projectInitScripts": []`; omitting the field is not
that declaration.

`ProjectFacts` is `{ scope, phase: "design" | "red" | "deliver", packs,
workspaces: WorkspaceFacts[], adapterTechnologies, workspaceTemplates }`.
`WorkspaceFacts` is `{ dir, name, kind, packageName, sourceRoot, contracts:
{ path, source }[] }`. Emitters parse the contracts they need: domain
concepts with the ts pack's parser (WI-3), features with ts-hexagonal's
parser (WI-5), both returning the `feature-model.ts` types.

Workspace template text may use only `{{scope}}` (`@example`), `{{name}}`
(`web`), `{{package}}` (`@example/web`) and `{{entries}}`. `{{entries}}` is
the workspace-relative paths of the files the composed emitters produce for
that workspace with `entry: true`, sorted by code point and joined by single
spaces (`src/export-projects.ts`); with none it is the empty string. The
Lambda app's manifest builds exactly its entries,
`bun build {{entries}} --outdir dist --target node`, so the composition root
and test files never become bundles. A manifest template has no
`name`; the generator sets it and `private: true`. A context's manifest
`exports` are `./domain`, `./application`, then `./adapters/<tech>` for each
technology folder present, in-direction ids sorted, then out-direction ids
sorted.

`workspaceScripts` is an optional object of npm script name → command. A
context workspace's manifest takes a technology's scripts, like its `pins`,
exactly when its tree has that technology's folder. Names are lowercase words
joined by `:` or `-`. Commands are one line, non-empty, with no surrounding
whitespace, and are copied verbatim, so they are relative to the workspace
directory. An empty object, and one script name contributed by two
technologies, are refused. ts-drizzle-postgres contributes the example's
`db:generate` (`drizzle-kit generate`) and `db:migrate`
(`bun --env-file=../../.env run drizzle-kit migrate`).

Root config files may use `{{project}}`: the scope without its `@`
(`example`). ts-drizzle-postgres's `docker-compose.yml` and `.env.example`
use it as the database name, as the example does. The config generator
substitutes it; no other placeholder is allowed there.

## Changes from the plan

1. **Emitters see the whole project.** The plan's `(contract, projectFacts)`
   became `emit(facts)`, because barrels, routers and MCP servers aggregate
   many contracts. `ProjectFacts` carries contract **sources**, not parsed
   models: the ts pack's gates build the facts but cannot import
   ts-hexagonal's parser. Adapter packs import ts-hexagonal's feature parser
   across their declared edge.
2. **Fewer degrees of freedom in `adapterTechnologies`.** It has no folder,
   export path or class prefix fields; all derive from `id` (`naming.ts`).
3. **One owner for out barrels.** ts-hexagonal emits every
   `adapters/out/<tech>/index.ts`, including drizzle's; WI-6 does not.
4. **The in-adapter test level is generated laws.** `adapters/in/<tech>/**`
   is generated, so a hand-written test there would be write-denied. The
   laws exercise the adapter factories with fake in ports (Q2).
5. **Added:** `ProjectFacts.phase` (the errors module is red-phase only),
   `emittedFileProblem`, the shared `naming.ts` (lead-owned after WI-1, like
   `pack.ts`), the CQRS verb list, the one-store-per-feature rule, the
   required MCP description from the in-port summary, and the store
   conformance-suite path.
6. **Deferred in v1:** optional and array `Input` fields are refused.
7. **`ts-desktop`** depends on `ts`, `ts-hexagonal` and `ts-trpc` (the
   router it hosts). Not on `ts-web`: a desktop app is not a web app and
   must not inherit its obligations. The router-hosting helpers both apps
   share live in `ts-trpc` (`scripts/router-host.ts`).
8. **Export order.** The example lists adapter exports in a hand-picked
   order. Generated manifests sort them, and comparisons treat `exports` as a
   map.
9. **Build entries.** `EmittedFile.entry` and the `{{entries}}` placeholder
   (§10) let a manifest list build entries derived from the design (WI-7).
10. **App packs act on declared apps only.** ts-web's `check:build` (the
   shipped `scripts/web-build-check.ts`) and `web-obligation` read the TN
   `workspaces:` maps and act on the `web` apps declared there; with none
   they do nothing and say so.
