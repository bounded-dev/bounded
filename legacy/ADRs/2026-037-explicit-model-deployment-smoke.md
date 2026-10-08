# 2026-037: Explicit model deployment smoke at reset

**Status:** accepted

## Decision

`dogfood-reset --smoke-models` opts in to one short provider request per
distinct configured model tier before either arm is archived or reset. The
probe retains the tier's thinking setting, disables tools and project context,
uses no persistent session, and fails on timeout, provider failure or an empty
reply. Ordinary resets check catalog membership and explicitly report that
limitation.

## Why

A registry can list models that have no served deployment. Run 28 lost two
resets to that distinction. Deployment requires a live request, which costs
money and therefore must be explicit; a catalog predicate cannot prove it.

## Consequences

New tier selections should use the smoke option. A probe proves access only
at that moment and has a 60-second limit per tier. Tests use fake executables
and never call providers. Neither successful probes nor catalog membership
claim that future requests will succeed.
