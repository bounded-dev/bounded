# Directory structure

## Repository

```
<repo>/
  package.json                 Bun workspaces: contexts/*, apps/*
  tsconfig.base.json           shared compiler options
  tsconfig.json                type-checks every context and app
  architecture.test.ts         enforces the dependency rule (generated)
  docker-compose.yml           local Postgres
  .env / .env.example          DATABASE_URL and other local settings
  docs/architecture/           this documentation (generated)
  contexts/
    <context>/                 one bounded context = one package
  apps/
    <app>/                     one deployable = one package
```

`contexts/` holds business logic. `apps/` holds things that run. Nothing else sits at the top level except repository tooling.

## A context

```
contexts/<context>/
  package.json                 @<scope>/<context>, with one export path per layer and adapter technology
  drizzle.config.ts            drizzle-kit config for this context's tables
  src/
    domain/
      index.ts                     generated
      shared/
        result.ts                  generated
        errors.ts                  generated while skeletons exist; removed at delivery
      <area>/
        <concept>.contract.ts
        <concept>.ts
        <concept>.test.ts
        <concept>.laws.test.ts     generated
    application/
      index.ts                     generated
      <area>/
        <feature>/
          <feature>.contract.ts
          <feature>.command.ts            generated, only if the feature takes input
          <feature>.command.laws.test.ts  generated, with the command
          <feature>.handler.ts
          <feature>.test.ts
          <feature>.store.test-support.ts the store conformance suite, if the feature has a store
    adapters/
      in/
        <tech>/                    generated from the contracts' @exposedVia tags
          index.ts
          <tech-root files>        e.g. trpc.ts, router.ts, server.ts
          <area>/
            <area>.<aggregator>.ts   e.g. <area>.router.ts
            <feature>.<kind>.ts      e.g. .procedure.ts, .tool.ts, .lambda.ts
      out/
        <tech>/
          index.ts                 generated
          <tech>-database.ts       the shared connection or state (storage technologies)
          <area>/
            <feature>.<role>.ts    e.g. .store.ts, .exporter.ts
            <feature>.<role>.test.ts
            <concept>.mapper.ts
        drizzle/
          schema/
            <context>.schema.ts    the Postgres schema namespace (generated)
            <area>.ts              table definitions
          migrations/              generated, committed
```

## An app

```
apps/<app>/
  package.json
  src/
    composition-root.ts        wiring (see apps-and-composition.md)
    composition-root.test.ts   the app's smoke test
    <entry>.ts                 hosts what the composition root returns
```

An app with both browser and server code splits `src/` into `client/` and `server/` (a desktop app into `renderer/` and `main/`); the composition root then lives at `server/composition-root.ts` (or `main/composition-root.ts`).

## Naming

| Thing | Rule | Example |
|---|---|---|
| Files, folders | kebab-case | `item-title.ts` |
| Area folders | plural business noun | `items/`, `order-lines/` |
| Feature folders | verb-first, kebab-case, at least two words | `create-item/`, `list-items/` |
| Contract files | `<name>.contract.ts` | `item-title.contract.ts` |
| Domain contract interfaces | the concept name, no suffix; static side `<Name>Factory` | `ItemTitle`, `ItemTitleFactory` |
| Domain implementation classes | `<Name>Impl`, never exported | `ItemTitleImpl` |
| Role suffixes | `.command.ts`, `.handler.ts`, `.store.ts`, `.mapper.ts`, `.procedure.ts`, `.tool.ts`, `.lambda.ts`, `.router.ts`, `.exporter.ts`, `.test.ts`, `.test-support.ts`, `.laws.test.ts` | `create-item.store.ts` |
| Classes | PascalCase; role as suffix | `CreateItemHandler`, `CreateItemCommand` |
| In-port interface | the feature name | `CreateItem` |
| Store out port | exactly `<Feature>Store`; at most one per feature | `CreateItemStore` |
| Other out ports | name the capability; never ending in `Store` | `ItemExporter` |
| Port role | the last word of the port name, lowercased: the adapter file's suffix and the handler's constructor parameter | `store`, `exporter` |
| Out-adapter class | technology + port name | `DrizzleCreateItemStore`, `InMemoryCreateItemStore`, `ConsoleItemExporter` |
| Storage database | `<Technology>Database` in `<tech>-database.ts` | `InMemoryDatabase` |
| Wire input interface | `<Feature>Input` | `CreateItemInput` |
| Command contract | `<Feature>Command`, `<Feature>CommandFactory`; implementation `<Feature>CommandImpl` (never exported) | `CreateItemCommand` |
| Wire schema | camelCase `<feature>Schema` | `createItemSchema` |
| Composition dependency key | camelCase feature | `createItem` |
| Packages | `@<scope>/<context>`, `@<scope>/<app>` | `@<scope>/inventory` |
| CQRS kind | a query when the verb is `count`, `find`, `get`, `list` or `search`; otherwise a command | `list-items` is a query |

Every package keeps its code in `src/`, so the package root only holds package-level files.

The same feature name is used in every layer, so one feature can be found everywhere with a single search: `create-item.contract.ts`, `create-item.handler.ts`, `create-item.store.ts`, `create-item.procedure.ts`.
