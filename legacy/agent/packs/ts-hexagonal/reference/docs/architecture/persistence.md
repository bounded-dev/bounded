# Persistence

## Database

- **Postgres** everywhere: development, tests and production. There is no SQLite or embedded database, because table definitions and migrations are specific to one database.
- **Drizzle ORM** for queries, and **drizzle-kit** to generate and apply migrations.
- Drizzle is an out-adapter technology. It lives in `adapters/out/drizzle/` and nothing outside that folder imports it.

## Layout

```
contexts/<context>/
  drizzle.config.ts
  src/adapters/out/drizzle/
    index.ts                   generated
    drizzle-database.ts        the shared database type the stores receive (generated)
    schema/
      <context>.schema.ts      pgSchema("<context_name>") (generated)
      <area>.ts                one file per area
    migrations/                generated SQL and drizzle-kit's meta/ snapshots
    <area>/
      <feature>.store.ts
      <feature>.store.test.ts
      <concept>.mapper.ts
```

## Rules

- **Each context owns a Postgres schema** named after it (for example `pgSchema("inventory")`), and all its tables are created in it. No context reads another context's schema.
- **Table definitions are split by area** (`schema/<area>.ts`), like the rest of the code.
- **Tables are an adapter detail.** They do not have to match the domain objects' shape; mappers translate between them.
- **References between areas** in the same context use foreign keys. References to other contexts are plain ID columns with no foreign key.
- **Migrations are generated, never hand-edited:** change `schema/`, generate the migration, and commit the SQL and the `meta/` folder together.
- **Stores depend on Drizzle's generic Postgres database type**, never on a specific driver. Their constructor is exactly `(private readonly db: DrizzleDatabase)`.
- **Store tests run against real Postgres** through Testcontainers, started lazily with the migrations applied (see [testing.md](testing.md)).

## Drivers

Each generated composition root uses the driver for its app's runtime:

| Runtime | Driver |
|---|---|
| Bun (web, MCP) | `drizzle-orm/bun-sql` |
| Node (Lambdas) | `drizzle-orm/node-postgres` (`pg`) |

## Local development

- `docker-compose.yml` at the repository root runs one Postgres that every app shares, with its data kept in a Docker volume.
- `DATABASE_URL` lives in the root `.env` (git-ignored). `.env.example` is the committed template.

| Command (from the repository root) | Does |
|---|---|
| `bun run db:up` | Starts Postgres |
| `bun run db:migrate` | Applies every context's pending migrations |
| `bun run --filter @<scope>/<context> db:generate` | Generates a migration from that context's schema changes |

These are for running the app locally. Tests and the project's own `check` never need them: store tests and each app's smoke tests start their own throwaway, migrated Postgres through Testcontainers (an app's through the generated `app-test-database.test-support.ts`, whose `useAppDatabase()` the smoke test calls as its first statement after the imports), so the check needs nothing but a container engine.

## Production

Migrations run as a deploy step (or a dedicated migration function) before new code starts. Infrastructure code for this is out of scope here.
