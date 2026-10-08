Build a **subscription billing** component in TypeScript.

A customer holds one subscription to a plan. A plan has a price and a billing
interval (monthly or yearly). The component must support:

1. **Start** — begin a subscription on a given date. The first billing period
   runs from that date to the end of the interval.
2. **Renew** — at the end of a period, charge the plan price and advance to the
   next period.
3. **Change plan mid-period** — effective immediately. The customer is credited
   for the unused part of the current period on the old plan, and charged for
   the remaining part of the period on the new plan (proration). The period end
   date does not move.
4. **Cancel** — takes effect at the end of the current period. No further
   charges. A cancelled subscription can be neither renewed nor changed.
5. **Invoice** — every charge or credit produces an invoice with line items,
   each line naming what it is for and its amount.

Rules:

- Money is always in the plan's currency. A plan change that would cross
  currencies is rejected.
- Proration is by whole days remaining in the period and rounds to the smallest
  unit of the currency. For any single period, the customer is never charged
  more than the new plan's full period price.
- Every operation carries a caller-supplied operation id and is idempotent:
  replaying an operation must never double-charge.
- Nothing may be back-dated. An operation dated before the start of the current
  period is rejected.
- A subscription's invoices, summed, must always equal the total the customer
  has actually been charged — no operation may leave the two out of step.

