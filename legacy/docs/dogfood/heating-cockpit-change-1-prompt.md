The ingest and rating core delivered in this repository is live at the pilot
buildings, and a change request has come in from the facility managers.

## Change request: two-tier availability gating

Today a meter whose data availability for the period is below 90% is not rated
at all — it goes to the inspection queue. The pilot shows that rule is both too
strict and too lenient: meters just under 90% produce plainly readable metrics
yet are parked in the queue, while genuinely dead meters wait in the same
undifferentiated list.

Change the availability rule as follows:

1. **The single 90% gate becomes two thresholds, both part of the versioned
   threshold set** (reference values for district heating given here — a
   different heat source may choose different numbers):
   - **Ratable minimum — 70%.** Below this, the meter is not rated at all and
     goes to the inspection queue, exactly as the old rule did at 90%.
   - **Full-confidence minimum — 90%.** At or above this, rating is unchanged
     from today.

2. **A meter with availability in between — at or above the ratable minimum
   but below the full-confidence minimum — IS rated**, on the same metrics and
   bands as any other meter, but its verdict carries a **reduced-confidence
   marking** the caller can see. Reduced confidence qualifies a verdict; it is
   never itself a band, and it must not change which band any metric lands in.

3. **The building roll-up treats reduced-confidence verdicts exactly like
   full-confidence ones** — worst-wins is unchanged — but the building status
   must expose whether any of its rated meters was reduced-confidence, so a
   manager reading a green building can see the green rests partly on thin
   data.

4. **Inspection-queue entries now carry the availability fraction that
   excluded the meter**, so the manager can distinguish a meter at 65% from a
   meter at 5% without opening it.

5. **Boundary rule:** state explicitly which side each of the two thresholds
   lands on, make both total, and keep the convention consistent with the
   component's existing boundary rules.

This is a **change to the delivered component**: evolve the existing spec,
contracts, tests and implementation in place — do not rebuild from scratch,
and do not leave the old rule behind as a parallel path. The result must read
as one coherent design, and `npm run check` must pass when you are done.
