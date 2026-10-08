Build a **renewable-site contract management** component in TypeScript.

An operator manages renewable energy **sites**. A site is **wind** (number of
turbines, blade diameter) or **solar** (number of inverters); every site,
whatever its kind, has a name and a total megawatt capacity. Each site has a
**management team** — the set of users allowed to change anything about that
site's contracts. Sites hold **contracts**; a contract names one **main
party** and one or more **counterparties**, runs from a start date to an end
date, and is one of two types with type-specific terms: an **O&M agreement**
(warranted availability, a percentage) or a **power purchase agreement**
(price per megawatt-hour, in a named currency). Every contract carries
**milestones** — named key dates such as contract start, contract end, or a
break period ending — and a **status**: draft, active, cancelled, expired, or
superseded. The component must support:

1. **Register a site** — with its kind-specific properties. Wind properties
   on a solar site (or the reverse) must be impossible to express, not merely
   rejected.
2. **Draft a contract** — for a site, with parties, type, terms, start and
   end dates. Drafting creates the start and end milestones automatically.
3. **Amend a draft** — terms, parties, dates, milestones. Only drafts are
   amendable; every other status is frozen.
4. **Activate** — a draft becomes active. To change an active contract,
   **supersede** it: activate a new draft that names it, which marks the old
   contract superseded and records the link both ways.
5. **Cancel** — an active contract, from a given date. Cancelling silences
   all of its future notifications.
6. **Add or remove a milestone** — on a draft or an active contract. Start
   and end milestones can be moved only by amending the dates (draft) or
   superseding (active), never removed.
7. **Notification sweep** — given today's date, emit a notification for each
   upcoming milestone of each active contract at each configured lead time
   (90, 30 and 7 days before the milestone). The sweep is how the operator
   hears about a break period ending before it has ended.

Rules:

- Every mutating operation names the acting user and is rejected unless that
  user is on the management team of the contract's site. A user on site A's
  team has no rights over site B's contracts. Reads are unrestricted.
- The main party is never also a counterparty, and a contract with no
  counterparty is rejected.
- The end date is after the start date; every milestone falls on or between
  them. Warranted availability is strictly between 0 and 100; megawatts,
  turbine count, blade diameter, inverter count and price are positive.
- The status lifecycle is one-way: draft → active → (cancelled | expired |
  superseded). Only a draft activates; only an active contract is cancelled
  or superseded; a contract whose end date has passed at sweep time is
  expired by the sweep. Terminal states never change again, and a
  superseding contract must belong to the same site as the one it replaces.
- A sweep never emits the same (contract, milestone, lead time) notification
  twice, however often it runs and whatever the gap between runs — running
  the same sweep twice adds nothing. A missed lead time is still emitted
  late by the next sweep rather than skipped, provided the milestone has not
  passed.
- Notifications come only from active contracts. After any sequence of
  operations and sweeps: every notification ever emitted names a milestone
  that belonged to a then-active contract, and each (contract, milestone,
  lead time) appears at most once — no operation may leave the emitted set
  out of step with that.
