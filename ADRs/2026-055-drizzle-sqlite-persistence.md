# 2026-055: Versioned SQLite persistence capability

**Status:** accepted

## Decision

Add `ts-drizzle-sqlite` as an optional TypeScript pack. It depends only on
`ts`, so it composes with or without a web or service pack. It pins Drizzle
ORM, Drizzle Kit and libSQL, and seeds project-owned schema, client and
migrator files under `src/db/`.

- **Config is generated (ADR 2026-054).** `drizzle.config.ts` is a pack
  reference file generated at the project root and listed in
  `projectConfigNames`. The migration check and generator execute it, so no
  role may write it and every toolchain gate refuses when it drifts. The
  migration check ships as `scripts/check-db.ts` (`projectShippedFiles`) and
  `check:db` is folded into `check` (`projectCheckScripts`), so the generated
  manifest is already the delivered one and delivery's own `npm run check`
  runs it. It is not also a delivery check. Database files are ignored
  through `projectIgnoreRules`.
- **Migrations are generator-only.** The history lives in `migrations/` at the
  project root, outside `src/`. Every role's write zone is an allowlist and
  none reaches it, so no role can write a migration or its snapshot, and no new
  path-policy socket is needed. `src/db/migrations/` would have needed one,
  because the builder writes `src/**`. Built output also finds a root folder
  from `dist/db/` exactly as it does from `src/db/`.
- **A generation gate, born with this consumer.** The ts pack defines the
  `artifactGenerators` socket and its consumer, the architect's
  `generate_artifacts` gate. The gate first runs the config drift check. It
  then requires a frozen design (the builder is commissioned only after one),
  and runs each composed generator. This pack contributes the migration
  generator. A project that composes no generator runs none.
- **Ambiguity fails closed.** Drizzle Kit asks a person whether a changed
  column or table is a rename. Without a terminal, 0.31.11 prints an error and
  exits 0 with nothing written. Both the generator and the check treat that
  output, and anything on stderr, as a refusal. The generator then says how to
  make the change unambiguous or hand it to the user's `npm run db:generate`.
- **Read-only check.** The check generates into a temporary copy through
  `BOUNDED_DRIZZLE_OUT`, verifies the committed history is unchanged, then
  applies it to a fresh temporary database.
- The seeded client and migrator resolve the database default and the
  migration folder from their own module location, not the working
  directory. They parse `file:` URLs the way the driver does.

## Why

Persistence is a capability, not an implicit property of a web or service
project. Versioned SQL makes upgrades explicit and reviewable. A migration is
derived from the schema, so a hand edit is a second, unreviewed source of
truth. Executable config the gates run must be deterministic.

## Consequences

An initialized project owns its tables, repositories and database data, and
commits its generated migrations. A rename needs two generations or the user.
`npm ci --ignore-scripts` installs a working Drizzle Kit: its esbuild copies
load their platform binaries from optional packages. Drizzle Kit 0.31.11
depends on an old esbuild through `@esbuild-kit/esm-loader`, which carries a
moderate advisory (GHSA-67mh-4wv8-2f99) about esbuild's development server.
Drizzle Kit never starts that server, and it is a development dependency only.
A different database backend needs its own pack; no database technology enters
the harness core.
