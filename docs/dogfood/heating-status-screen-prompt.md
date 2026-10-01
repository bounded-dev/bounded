Facility managers need a **building status screen** for the heating
dashboard. This ticket is the screen only: the data it shows is handed to
the screen by its caller, and wiring it to the backend is a later ticket —
design the screen's input as part of your job.

What a facility manager must see for one building and one reporting period:

1. **The building's overall verdict**, prominently — one of: very good,
   acceptable, critical, very critical, or "no rated meters". A manager
   glancing at the screen must be able to tell good from critical without
   reading detail.

2. **The meters, worst first** — each meter showing its id, its overall
   verdict, and its three metric readings (spread, return temperature,
   low-ΔT share) with each metric's band visible. A meter whose metric was
   not computed shows that plainly — absence must not look like health.

3. **The inspection queue** — meters excluded from rating for low data
   availability, listed with their availability, and a visible count even
   when the queue is collapsed or empty ("Inspection queue (3)"). A building
   whose every meter is queued must read as "no rated meters", never as
   healthy.

4. **An empty state** — a building with no report for the period says so in
   words a manager understands, not a blank region.

The screen must be usable by a manager who reads quickly: verdicts must be
distinguishable by text as well as by any colour (colour alone is not
information), and every number carries its unit.

`npm run check` must pass when you are done.
