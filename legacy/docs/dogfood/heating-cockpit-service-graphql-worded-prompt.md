The ingest and rating core in this repository is live at the pilot
buildings. The web team is now building the facility-manager dashboard and
needs to call the core from outside this process.

## Change request: expose the core to the dashboard over GraphQL

1. The dashboard must be able to **submit a building's period report** — the
   same report the core ingests today, with the same guarantee: re-submitting
   the same building and period replaces the earlier report entirely, never
   appends, never double-counts.

2. The dashboard must be able to **fetch the stored status** for a building
   and period — the rated meters, the inspection queue, the overall verdict,
   exactly what the core already produces.

3. A lookup for a building and period nobody has ingested must fail in a way
   the dashboard can distinguish from an error and show to the user.

4. A malformed submission must be rejected with something the dashboard can
   act on, and must never partially apply.

Do not change what the core computes; its existing behaviour and tests must
survive untouched unless a genuine seam is missing. `npm run check` must
pass when you are done.
