The ingest and rating core in this repository is live, and the web team now
needs to call it over the network. Extend this repository with a **tRPC
service layer** exposing the core to typed clients.

## Change request: a tRPC service over the cockpit core

Add a **new component** — the service layer — beside the existing one. It is
an adapter, not a second brain: every domain decision (rating, idempotency,
thresholds) stays in the core, and the service must consume the core only
through its existing public surface. Do not modify the core unless the
service genuinely cannot be built without a new seam; if you must, that is a
contract revision with a logged rationale, as any other.

The service, concretely:

1. **Procedures.** A tRPC v11 router (`@trpc/server` 11.18.0 is installed;
   add nothing else) with:
   - `ingestReport` — **mutation**: accepts a building report for a period,
     runs the core's idempotent ingest-and-rate, returns the resulting
     building status. Re-submitting the same building and period replaces, as
     the core already guarantees.
   - `buildingStatus` — **query**: returns the stored status for a building
     and period, or a typed not-found error if nothing was ingested for that
     pair.

2. **The wire is untyped; the boundary types it.** Requests arrive as
   untrusted JSON. Input validation must reuse the component's existing
   parse-based value objects — the domain already knows what a valid
   availability, temperature or period is, and a second validation schema
   would be a second identity for the same value (this repository treats that
   as a defect). A rejected input fails with tRPC's `BAD_REQUEST`, carrying
   which field failed and why, without leaking internals.

3. **Not-found is a verdict, not an exception leak.** An unknown
   (building, period) pair on `buildingStatus` maps to tRPC's `NOT_FOUND`
   with a message a frontend can show.

4. **Dependencies are injected, not ambient.** The core's ports (the report
   store, the clock) reach the router through tRPC context, so a caller — a
   test or a real server — decides what backs them. The service itself
   constructs no store and reads no clock.

5. **Typed end to end, testable without a socket.** A consumer must be able
   to obtain the router's type for a typed client, and the suite must
   exercise the service through tRPC's own server-side caller — no HTTP
   listener, no port binding, no network in tests.

6. **The service's spec section states its error taxonomy** — which failures
   map to which tRPC codes — and the mapping must be total: every way a call
   can fail lands in a stated code, nothing falls through as an internal
   error by accident.

This is a change to the delivered repository: evolve the existing spec and
add the new component's contracts, tests and implementation through the same
flow as everything else here. The core's existing behaviour must not change,
its existing tests must still pass untouched unless a deliberate core
revision makes them wrong, and `npm run check` must pass when you are done.
