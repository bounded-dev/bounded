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
docker-compose.yml  .env.example                                shipped (ts-drizzle-postgres)
docs/architecture/*.md                                          generated (ts-hexagonal)
contexts/<context>/
  package.json  drizzle.config.ts                               config
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

Two JSDoc tags carry meaning; contract lint allows them and no other tag has
semantics. A tag lives in the `/** … */` block directly above the interface
it describes.

```
exposed    = "@exposedVia"    1*( SP tech-id )      ; on the in port only
implemented = "@implementedBy" 1*( SP tech-id )     ; on a non-store out port only
tech-id    = kebab-case id of a composed adapter technology
```

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
WI-7 fixes the remaining combinations and records them here.

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
| `in/lambda/<area>/<feature>.lambda.ts` | `export const create<InPort>Lambda = (<camel(feature)>: <InPort>) => async (): Promise<void> => { await <camel(feature)>.execute(); };` (for an input-less `void` feature, as `export-projects`; WI-7 fixes the others) |
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
| `contexts/*/src/adapters/out/drizzle/drizzle-database.ts` | ts-drizzle-postgres | WI-6 |
| `contexts/*/src/adapters/out/drizzle/schema/*.schema.ts` | ts-drizzle-postgres | WI-6 |
| `contexts/*/src/adapters/out/drizzle/migrations/**` | ts-drizzle-postgres | WI-6 |
| `contexts/*/src/adapters/out/drizzle/drizzle-test-database.test-support.ts` | ts-drizzle-postgres | WI-6 |

Generated laws include `<concept>.laws.test.ts`,
`<feature>.command.laws.test.ts` and the in-adapter laws
`in/<tech>/<area>/<feature>.<role>.laws.test.ts`. Manifests, `tsconfig*`,
`bun.lock` and `drizzle.config.ts` are generated **config** (ADR
2026-054), protected by the config-name sockets rather than these globs.

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
refusal at green.

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
| `adapterTechnologies` | data | ts, same file | contrib entry `{ id, direction: "in"\|"out", description, featureRole? (in), storage? (out), pins? }`; read with `adapterTechnologies(packs)` → `AdapterTechnology[]` |
| `workspaceTemplates` | data | ts, same file | contrib `{ <kind>: { root, manifest, description, files?: { <path>: { source, mode } } } }`; read with `workspaceTemplates(packs)` → `WorkspaceTemplate[]` |

`ProjectFacts` is `{ scope, phase: "design" | "red" | "deliver", packs,
workspaces: WorkspaceFacts[], adapterTechnologies, workspaceTemplates }`.
`WorkspaceFacts` is `{ dir, name, kind, packageName, sourceRoot, contracts:
{ path, source }[] }`. Emitters parse the contracts they need: domain
concepts with the ts pack's parser (WI-3), features with ts-hexagonal's
parser (WI-5), both returning the `feature-model.ts` types.

Workspace template text may use only `{{scope}}` (`@example`), `{{name}}`
(`web`) and `{{package}}` (`@example/web`). A manifest template has no
`name`; the generator sets it and `private: true`. A context's manifest
`exports` are `./domain`, `./application`, then `./adapters/<tech>` for each
technology folder present, in-direction ids sorted, then out-direction ids
sorted.

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
7. **`ts-desktop`** depends only on `ts` and `ts-hexagonal` for now. WI-7
   adds its edges to the tRPC and web packs.
8. **Export order.** The example lists adapter exports in a hand-picked
   order. Generated manifests sort them, and comparisons treat `exports` as a
   map.
