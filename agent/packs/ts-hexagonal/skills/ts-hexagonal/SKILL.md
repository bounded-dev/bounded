---
name: ts-hexagonal
description: Design, test or build a TypeScript project laid out as a hexagonal Bun monorepo (bounded contexts under contexts/, apps under apps/, domain/application/adapters layers). Use when the project composes ts-hexagonal, when writing a feature or domain contract, a handler or store test, or a handler, store, adapter or composition root. Has one section per role.
---

# Hexagonal monorepo

The project is a Bun monorepo: one package per bounded context under
`contexts/<context>/`, one per deployable under `apps/<app>/`. Each context's
`src/` is split into `domain/`, `application/` and `adapters/in|out/<tech>/`,
and dependencies point inwards only: domain ← application ← adapters ← apps.

The project's own rulebook is `docs/architecture/` (start at `README.md`).
The complete worked example is this pack's `reference/`: one context with
every file kind and a test at every level. Copy its shapes.

Everything mechanical is **generated** from the contracts and is readable by
every role but written by none: `domain/index.ts`, `domain/shared/result.ts`,
`application/index.ts`, `<feature>.command.ts`, every `*.laws.test.ts`,
everything under `adapters/in/`, every `adapters/out/<tech>/index.ts`,
`architecture.test.ts` and `docs/architecture/`. While skeletons exist,
`domain/shared/errors.ts` holds `NotImplementedError`; delivery removes it.

## Names you never choose

| Thing | Name |
|---|---|
| Area folder | plural business noun: `notes`, `order-lines` |
| Feature folder | verb first, at least two words: `create-note`, `list-notes` |
| In port | `pascal(feature)`: `CreateNote` |
| Store out port | exactly `<InPort>Store`, at most one per feature |
| Other out port | names its capability, never ends in `Store`: `ProjectExporter` |
| Handler | `<InPort>Handler` in `<feature>.handler.ts` |
| Out adapter | `<Tech><Port>` in `adapters/out/<tech>/<area>/<feature>.<role>.ts`, role = the port name's last word |
| Storage database | `<Tech>Database` in `adapters/out/<tech>/<tech>-database.ts` |

A query is a feature whose verb is `count`, `find`, `get`, `list` or
`search`; everything else is a command.

## Architect

You write `*.contract.ts` files and the apps a ticket needs.

- **Domain concept** `contexts/<ctx>/src/domain/<area>/<concept>.contract.ts`:
  `interface <Name>` with `readonly __brand: "<Name>"`, plus
  `interface <Name>Factory`. Value objects: `parse(raw: unknown): Result<Name>`;
  identifiers add `generate()`; entities declare `new (...)`. Import only
  other contracts and `../shared/result.ts`, always `import type`.
- **Feature** `contexts/<ctx>/src/application/<area>/<feature>/<feature>.contract.ts`,
  in exactly this order (the parser refuses anything else, naming the fix):
  1. one import: `import type { … } from "@<scope>/<ctx>/domain"`, names
     sorted, every name used, `Result` when used;
  2. `<InPort>Input`, `<InPort>Command`, `<InPort>CommandFactory` (all or
     none). Input fields are `readonly` `string | number | boolean`; the
     Command repeats them, same order, typed by value objects or identifiers,
     after `readonly __brand: "<InPort>Command"`; the factory is exactly
     `parse(raw: unknown): Result<<InPort>Command>`;
  3. the in port: one `execute`, taking `(command: <InPort>Command)` or
     nothing, returning `Promise<R>` or `Promise<Result<R>>` where R is
     `void`, a concept or an array of one;
  4. the out ports. Their order is the handler's constructor order. No two may
     end in the same word.
- **Shared ports** `contexts/<ctx>/src/application/shared/<name>.contract.ts`:
  port-level interfaces every feature of the context may use (a clock, an
  event publisher); type imports and `export interface` only. A feature
  imports them after the domain barrel as
  `import type { … } from "../../shared/<name>.contract.ts"`.
- **Names.** A context may not share its name with one of its areas (the
  generated tRPC router would define `create<Name>Router` twice): call the
  context `project-management`, not `projects`.
- **`@accepts`** on every value object and every identifier: a doc comment
  with the validity rule and two different valid literals, one tag per line.
- **Tags**, in the `/** */` block directly above the interface:
  `@exposedVia trpc mcp` on the in port names the in adapters to generate
  (the block's first line is the summary, required with `mcp`: it is the tool
  description); `@implementedBy console` is required on every out port that is
  not the store. A near-miss tag (`@exposedvia`, a tag in a `//` comment) is
  refused, never ignored.
- **Apps** are declared in the ticket TN's front matter, block form only:
  `workspaces:` then `  apps/web: web`. Contexts are never declared: they
  come from contract paths.

## Test writer

You write `*.test.ts` and `*.test-support.ts` next to the code they test,
against contracts. You never write under `adapters/in/` (its tests are
generated laws) and never write a `*.laws.test.ts`.

| Level | File |
|---|---|
| Domain unit | `domain/<area>/<concept>.test.ts` |
| Handler | `application/<area>/<feature>/<feature>.test.ts`, fakes of the feature's own out ports written inline |
| Store conformance suite | `application/<area>/<feature>/<feature>.store.test-support.ts`, exporting a function that takes a factory for the store under test |
| Store, per storage technology | `adapters/out/<tech>/<area>/<feature>.store.test.ts`, running the suite |
| Other out adapter | `adapters/out/<tech>/<area>/<feature>.<role>.test.ts` |
| App smoke | `apps/<app>/src/**/composition-root.test.ts`, against `compose<Entry>()`; runs once the app is built |

- Construct a handler exactly as its skeleton does:
  `new CreateNoteHandler(fakeStore)`, out ports in declaration order.
  Construct a store as `new InMemoryCreateNoteStore(new InMemoryDatabase())`.
- The conformance suite's factory also supplies what the port itself cannot
  do (seeding rows, reading back what was saved), built from the context's
  *sibling* stores over the same database, never from the database's fields
  (they are the builder's); see
  `reference/…/create-note.store.test-support.ts` and its in-memory store test.
  The suite calls every port method; each store test imports it.
- Every value object and identifier gets a `<Name> — boundaries` block (em
  dash): one accepted literal (from the contract's `@accepts`) and two
  distinct rejected literals of its base type, asserted as
  `expect(X.parse(v).ok).toBe(true|false)` or `toEqual({ ok: … })`.
- **Never test generated code**: a `<feature>.command.ts`, anything under
  `adapters/in/`, or what a `*.laws.test.ts` covers. Their generated laws
  test them, and they work before anything is built, so such a test passes
  at red and red refuses it. A handler test may build its input with the
  command; it must not be a test of the command.
- **Test files import as the code beside them may**, because
  `architecture.test.ts` reads them too. A domain test imports each concept
  from its own file by relative path, never the domain barrel:

  ```ts
  import { NoteText } from "./note-text.ts";                          // right, in domain/notes/note.test.ts
  import { NoteText } from "@example/project-management/domain";     // wrong there: a domain file never imports its own package
  ```

  An application test takes domain values from the barrel
  `@<scope>/<context>/domain` and everything of its feature from the
  feature's own files (`./create-note.handler.ts`), never the `/application`
  barrel. An out-adapter test imports its own technology's files and the
  conformance suite by relative path, never another technology's.
- Never `test.skip` or `test.todo`; never call a skeleton at a file's top
  level.
- Postgres store tests need a container runtime. Without one they are skipped
  with the reason logged while you write them; they must run before delivery.
- Use `bun:test` (`describe`, `test`, `expect`, `spyOn`). One behaviour per
  test.

The lint rules that bind your files, run at red, with the fix each one names:

| Rule | What it refuses |
|---|---|
| `test-imports` | a test import `architecture.test.ts` would fail on: a domain test importing the domain barrel or application code, an application test importing the application barrel or an adapter, an out-adapter test importing another technology, any test importing another context, a test outside the layers |
| `no-generated-subject` (the ts pack's) | a test, or a whole test file, whose only subjects are generated modules |

## Builder

You write implementation bodies. Skeletons exist before you start; keep their
declarations exactly, and replace each `throw new NotImplementedError(…)`.

- **Domain**: the body of `<Name>Impl`; the two trailing exports stay.
- **Handler**: the body of `execute`, plus private helpers. Types come from
  the feature's contract, never from the command file.
- **Stores and other out adapters**: method bodies, plus fields on
  `<Tech>Database`. Mappers (`<concept>.mapper.ts`) rebuild value objects with
  `parse` and throw on corrupt rows.
- **Composition roots** (`apps/<app>/src/**/composition-root.ts`): the only
  place that constructs handlers, stores and in adapters. Entry files host
  what it returns and import from contexts as types only.
- Browser code (`client/`, `renderer/`) imports server code with
  `import type { … }` only; `import { type … }` still loads the module.

The lint rules that bind you, with the fix each one names:

| Rule | What it refuses |
|---|---|
| `layer-dependency` | domain importing application or adapters, application importing adapters, one adapter importing another, domain or application code using a library other than zod, an app importing another app or a context other than through `domain`, `application` or `adapters/<tech>` |
| `no-cross-context-import` | a context importing another context or an app, except an out adapter importing another context's `application` |
| `no-io-in-core` | domain or application code (tests excepted) loading `node:fs`, `fs`, `node:child_process`, `node:net`, `bun` or a subpath of one, or using `Bun.file`, `Bun.write`, `Bun.spawn` or `process.env`, directly, through `globalThis`, or in a form the check cannot see through |
| `file-role-suffix` | a file whose folder and suffix match no row of the layout |
| `naming` | a singular area, a noun-first or one-word feature, a handler or adapter class not named as derived |
| `handler-shape` | a handler that is not one exported `<InPort>Handler implements <InPort>` with `private readonly <role>: <Port>` constructor parameters and `execute` as its one public method |
| `composition-root-only-constructs` | `new` of a handler or adapter class (also off a namespace), a call to an in-adapter factory, a value namespace import or a runtime load of application or adapter code, outside a composition root (tests excepted) |
| `entry-hosts-only` | an app file other than the composition root importing a context by value |
| `client-type-only-server-imports` | browser code importing server code other than with `import type` |
| `in-adapter-uses-in-port` | an in adapter naming a handler class, or taking application code whole (namespace, default, `export *`, runtime load) |

`architecture.test.ts` checks the same boundaries over the whole tree with
`bun test`. The checks that end a change are `bun test` and
`bunx tsc -p tsconfig.json`.
