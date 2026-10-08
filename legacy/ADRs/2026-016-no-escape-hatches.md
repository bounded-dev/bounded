# 2026-016: The type checker cannot be switched off — no exemption list

**Status:** accepted

## Decision

In target projects, `!`, `as` (except `as const`), `any`, and
`@ts-ignore`/`@ts-expect-error` are gate failures in `src/**` AND `tests/**`,
with `noInlineConfig` so a disable-comment cannot reopen a rule. The lint
config is constructed programmatically by the gates; the target repo carries
no lint file anyone could weaken. There is no exemption list.

## Why

The type checker is a harness layer, and these are the four syntaxes that
switch it off per-expression. A model under pressure to reach green takes the
cheapest path out: Run 7 shipped a runtime contract violation tsc had already
caught (`!` on a `find()` result); Runs 8 and 9 wrote 8 and then 19 hatches,
caught at green and genuinely fixed. Tests are included because a suite that
silences the checker can assert its way past anything (Run 10's helpers).
An exemption list is a place a model reasons toward — Run 9's design-level
loophole was found by exactly that search — so the ban is family-wide and
absolute; the canonical value-object class (ADR 2026-015) is what makes a
blanket ban livable.

## Consequences

Escape-hatch pressure surfaces as CONTRACT-DISPUTE instead of casts — which
is correct routing: the times an implementer "needs" a cast have so far been
contract defects. Test fixtures unwrap parses with explicit checks.
