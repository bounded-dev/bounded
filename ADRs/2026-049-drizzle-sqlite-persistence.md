# 2026-049: Versioned SQLite persistence capability

**Status:** accepted

## Decision

Add `ts-drizzle-sqlite` as an optional TypeScript pack. It pins Drizzle ORM,
Drizzle Kit, and libSQL; seeds project-owned schema and connection files; and
supplies commands to generate, check, and apply committed SQL migrations.
Delivery checks for schema drift and fresh-database migration failure only when
the project selected this pack. Applications call the pending-migration runner
before serving requests or importing data.
The TypeScript pack owns a generic artifact-generation gate; selected packs
contribute generators, so a bound architect can invoke them without a shell.

## Why

Persistence is a capability, not an implicit property of a web or service
project. Versioned SQL makes later upgrades explicit and reviewable. Generating
into a temporary copy makes the check read-only for project files. SQLite is the
first backend; the product's domain interfaces remain independent of it.

## Consequences

An initialized project owns its table definitions, repositories, migration
files, and database data. A different database backend will need its own pack
and migration configuration; no database technology enters harness core.
