# LEG-2026-049: Review ownership of business rules

**Status:** accepted

## Decision

The architect identifies the authoritative value and decision point for each business concept before implementation. The independent design reviewer challenges business rules or finite value sets duplicated across the domain, UI, service and adapters, citing the competing declarations. Presentation mappings remain with the UI. Repeated, well-defined violations may become pack-owned static rules or generated cross-boundary checks.

## Why

Import direction and type checks cannot tell whether a UI calculation is a business decision or a display choice. An explicit ownership challenge catches semantic duplication before separate implementations and tests make it harder to move.

## Consequences

This is a review judgment, not a claim of complete deterministic enforcement. New machine checks need a specific consumer and evidence that they detect a real class of mistakes without treating ordinary presentation as domain logic.
