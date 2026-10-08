Build the **ingest and rating core** of a district-heating "cockpit" — the
app-side component that receives a period's already-computed heating metrics
for a building, stores them idempotently, and rates each meter with a
traffic-light verdict a facility manager can read at a glance. In TypeScript.

## The domain, in brief

A building is heated by district heating. One **main meter** measures heat
entering the building; one **sub-meter** per apartment measures what that
apartment draws. Every meter reports, per period, a set of already-aggregated
metrics (an upstream Python analytics job computes them from 15-minute
telemetry — that job is NOT in scope here; you receive its output). Your job is
the app side: accept that output, keep it, and turn each meter's metrics into a
rating plus an action for the facility manager.

The three metrics that drive a meter's rating:

- **Spread (ΔT)** — the *median*, over the period's active-heating samples, of
  (flow temperature − return temperature), in kelvin. High spread = heat
  delivered efficiently; low spread = water passing through without giving up
  its heat.
- **Return temperature** — the *mean*, over active-heating samples, of the
  temperature of water returning to the plant, in °C. Water returned too hot is
  penalised by the tariff, so lower is better.
- **Low-ΔT share** — the fraction of the period's active-heating hours in which
  spread was below 5 K, as a percentage. Higher = more time spent running
  inefficiently.

## What the component must do

1. **Ingest** — accept a period's report for one building: the reporting
   period, the building, and for each meter its role (main or sub), its
   data-availability fraction for the period, and the three metrics above
   (each metric may be absent if the upstream job could not compute it). Ingest
   is **idempotent per (building, period)**: re-ingesting the same building and
   period replaces the earlier report entirely — never appends, never
   double-counts, and the result is exactly as if only the latest had been
   ingested.

2. **Rate each meter** — from its stored metrics, produce a per-meter verdict.
   A meter is rated on the three metrics, each mapped to a band by the
   thresholds below, and the meter's overall verdict is its **worst** band
   across the three (a meter is only as good as its weakest metric):

   - **Spread (median), kelvin** — `> 20` very good · `10–20` acceptable ·
     `5–10` critical · `< 5` very critical.
   - **Return temperature (mean), °C** — `< 45` very good · `45–50` acceptable ·
     `50–55` critical · `> 55` very critical.
   - **Low-ΔT share, percent of active hours** — `< 20` good · `20–50` notable ·
     `> 50` critical.

   The band boundaries are inclusive on the side stated and the metric's
   direction of "better" is as described (higher spread better; lower return
   temp and lower low-ΔT share better). Where a boundary value could fall in two
   bands, the spec must state which it lands in and the code must agree — pick a
   rule and make it total.

3. **Gate rating on data availability, first.** A meter whose data availability
   for the period is **below 90%** is **not rated at all**: it is marked "no
   data / defective" and routed to the **inspection queue** instead of
   receiving a traffic-light verdict. This check precedes every metric check —
   an unavailable meter is never also given a spread or return-temp band.

4. **A metric the upstream job could not compute is not a passing metric.** If a
   meter is rated (availability ≥ 90%) but a metric is absent, that metric
   cannot contribute a band, and the meter's verdict must reflect that the
   metric is missing rather than silently treating absence as good. Decide how a
   missing metric affects the overall verdict and state it; absence must never
   round up to a better rating than a present bad value would.

5. **Roll the building up.** From its meters' verdicts, give the building an
   overall status — again worst-wins across its *rated* meters — and expose the
   two lists a facility manager acts on: the meters ranked worst-first (the
   anomalies to look at), and the inspection queue (the meters excluded for low
   availability). A building whose every meter is in the inspection queue has no
   rated meters, and its status must say so rather than defaulting to good.

## Rules that hold across the whole component

- **Thresholds are a versioned set, not constants.** Every number in §2 and the
  90% in §3 belongs to a named, versioned threshold set that is district-heating
  reference values today. A different heat source (heat pump, gas, underfloor)
  is a different set of numbers against identical logic. The rating logic must
  read its thresholds from the set it is given; swapping the set must need no
  change to the logic. Which set rated a report is part of the stored result.

- **A rating is reproducible from what is stored.** Given the same stored report
  and the same threshold set, rating produces the same verdicts every time —
  no clock, no ambient state, no randomness enters rating.

- **Physical quantities are not bare numbers on the public surface.** A
  temperature, a kelvin spread, a percentage, an availability fraction, a
  period, a building id, a meter id each carry their meaning in the type — a
  return temperature and a spread must not be interchangeable just because both
  are numbers, and a percent must not be assignable where a fraction is meant.

- **The reporting period** is one of: a single month; a *tertile* of the heating
  year — Nov–Feb, Mar–Jun, or Jul–Oct; or a full period spanning a start and
  end. Periods are compared and must be equal for idempotency to apply: the same
  building and the same period replace; a different period is a different report.

- **The stored report and its verdicts are one interface to a caller** (the web
  frontend reads them). The shape you store, the shape you rate, and the shape
  you expose are a deliberate design, versioned so the upstream analytics can
  evolve without breaking the app.

Everything the upstream analytics job does — reading telemetry, deciding which
samples are "active heating", computing the medians and means — is out of scope.
You receive those aggregates; you do not recompute them. Do not add
dependencies; everything needed is installed.
