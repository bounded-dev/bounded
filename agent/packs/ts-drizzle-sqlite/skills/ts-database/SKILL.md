---
name: ts-database
description: Build or change persistent TypeScript data storage when the project selected ts-drizzle-sqlite. Covers schema ownership, SQLite migrations, repository boundaries, database startup, and when the architect generates migrations.
---

# Persistent data

The project selected `ts-drizzle-sqlite`. It has a local SQLite database through
Drizzle. The product owns its tables and data rules; this capability supplies
the driver and migration workflow.

Describe storage needs in the product design. Put domain meaning and validation
in domain components, and expose a repository interface to callers. Keep table
definitions and SQL details in the persistence implementation. The UI should
consume service read models, never query tables or duplicate a list of domain
values. A database schema does not decide the public service contract.

## Who writes what

- The builder changes `src/db/schema.ts` and implements repositories under
  `src/db/` against the domain interfaces.
- `migrations/` (the SQL files and Drizzle's `meta/` snapshots) is generated.
  No role may write it: it sits outside every role's write zone.
- `drizzle.config.ts` and `scripts/check-db.ts` are generated project config.
  No role may write them, and every gate that runs the toolchain refuses if
  they drift. A change to them is a capability change, escalated to the user.

## The architect's loop

After the builder changes the schema, the architect calls `generate_artifacts`.
That gate runs this capability's migration generator, which writes the next
versioned migration into `migrations/` and logs the result. Review the
generated SQL before `green_gate`: a wrong migration is a wrong schema, so
route the correction to the builder and generate again.

The generator cannot answer Drizzle's rename question. When a column or table
is renamed, Drizzle must ask whether it is a rename or a drop-and-create, and
the gate refuses with nothing written. Either make the change unambiguous (add
the new column in one ticket step, generate, then remove the old one and
generate again), or escalate to the user, who runs `npm run db:generate` in a
terminal and answers the prompt.

## Project commands

- `npm run check:db` (part of `npm run check`): detects schema drift or broken
  migration history without changing the project. It generates into a
  temporary copy and applies the committed migrations to a fresh temporary
  SQLite database. Delivery blocks when it fails.
- `npm run db:migrate`: applies pending committed migrations to `DATABASE_URL`
  (default `file:./data/app.sqlite`).
- `npm run db:generate`: the user's command for an ambiguous change. Never use
  `drizzle-kit push` for tracked product data; it bypasses the versioned history.

## Runtime

Call `migrateDb()` from `src/db/migrate.ts` before the service accepts requests
and before a data refresh imports rows. Failed migrations must stop startup or
refresh. The client and the migrator find the project root from their own
location, so they work from any working directory and from the built output.
Without `DATABASE_URL` the database is `data/app.sqlite` in the project. Keep
database files out of Git; the SQL history belongs in Git. A later backend can
supply a different driver and configuration without changing the domain
interfaces.
