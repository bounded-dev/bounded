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

---

## How this codebase must be built

These are the engineering standards for this project. Follow every one of
them — they are requirements, not suggestions. Work top to bottom.

### Process

1. Write `spec.md` first: the domain rules above, expanded into precise,
   testable statements — including the exact precedence order of every
   operation's rejection rules.
2. Design the public surface as **contract files** before writing any
   implementation: `src/**/*.contract.ts`, declaration-only (`declare`
   functions and classes, interfaces, type aliases — no function bodies, no
   enums, no value imports). Split into as many contract files as the design
   has cohesive areas — shared vocabulary (money, ids, dates) separate from
   operations. One god-file is wrong.
3. Write the **complete test suite before any implementation exists**. Then
   run it and confirm every test fails because behaviour is missing — report
   the failing count. Only then implement.
4. Implement until `npx tsc --noEmit` and `npx vitest run` both pass.
5. Finish with delivery: a `src/index.ts` barrel exporting the public
   surface, a README section explaining the contract convention, and a
   `FINDINGS.md` honestly listing anything you noticed that is questionable,
   unverified, or worth a reviewer's attention — an empty list is a claim,
   so only write one if it is true.

### Value objects

Every domain scalar (currency, money amount, ids, dates, plan names…) is a
**nominal class**, never a bare primitive and never a branded type alias:

```ts
/** ISO-4217 alphabetic code: exactly three uppercase letters.
 * @accepts "USD"
 * @accepts "EUR"
 */
export declare class Currency {
  private readonly __brand: "Currency";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): Currency | undefined;
}
```

- The private `__brand` literal matches the class name exactly.
- The constructor is private; `static parse(raw: unknown)` is the only door
  in, returning `undefined` on rejection — never throwing.
- Instance properties are `readonly` public fields, not getters.
- Every value-object class carries a doc comment stating its validity rule,
  plus two distinct `@accepts` examples.
- `type Currency = string & { __brand: … }` is banned in both its optional-
  and required-brand forms. No naked `string`/`number` anywhere on a public
  surface.

### Type discipline

Nowhere in `src/` **or** `tests/` may you use: `!` (non-null assertion),
`as` casts (`as const` is fine), `any`, or `@ts-ignore`/`@ts-expect-error`.
When the type checker complains, fix the cause. A test fixture unwraps a
parse honestly:

```ts
const usd = Currency.parse("USD");
if (usd === undefined) throw new Error("fixture");
```

Composite parsers narrow `unknown` with `typeof` and `in` checks, never
casts. tsconfig strictness stays exactly as provided.

### Surface discipline

Each implementation file's **exported public surface matches its contract
file exactly** — every declared export and member present with the declared
signature, and nothing public the contract does not declare. Helpers are
private. No convenience re-exports of another module's classes.

### Size discipline

Per function: cyclomatic complexity ≤ 15, ≤ 60 lines (comments and blanks
free), nesting depth ≤ 4. Per file: ≤ 350 lines. These are ceilings — if a
design presses against them, decompose the design; never compress code to
duck a limit.

### Test discipline

- Every exported value of every contract is called by at least one test.
- Every value-object class gets a `describe("<Name> — boundaries")` block
  (em dash) containing at least one accepted literal and at least **two
  distinct rejected literals of the value object's own base type** ("usd",
  "US" — wrong-value strings, not just `null`). Two is the floor: cover one
  rejection per axis of the validity rule.
- Every value-object class also gets rejection tests for hostile inputs:
  `undefined`, `null`, booleans, `NaN`, `Infinity`, `""`, arrays, objects,
  functions, dates — and law tests: two parses of the same input are equal
  in content; `equals` (where present) is reflexive, symmetric, and not
  reference-based; parsing is deterministic.
- Build all domain fixtures inside `test()`/`beforeEach`, never at module
  top level.
- Tests assert observable behaviour through the public surface only.
