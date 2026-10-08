# LEG-2026-043: Product-first initialization with additive scaffolds

**Status:** accepted

## Decision

Bare `bounded init` tells the current agent to ask for the product before
discussing implementation: since ADR LEG-2026-065, the product spec first, mapped
to product surfaces. The agent infers capability names
privately and plans the complete selection; an unsupported requirement blocks
initialization rather than being silently dropped. The CLI invokes no model.
The core can run one scaffold contribution from each selected capability in
dependency order. Each pack owns its output and must be additive with other
selected packs; the core validates that every selected capability is covered
by an initializer or is a dependency of one.

## Why

Exposing pack names as the first question made the agent ask users to design
the harness instead of describing their product. A single-initializer limit
prevented a web and service project even when both packs can scaffold their
own part.

## Consequences

The plan still shows the concrete files and requires a reviewed digest before
writing. Pack combinations can refuse on a real file or script collision.
Terminal `--interactive` remains an explicit technical selection for people
who already know the capabilities they want.
