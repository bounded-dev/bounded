# 2026-036: Project composition selects rules and delivery obligations

**Status:** accepted

## Decision

Every project records its selected packs in `.bounded/composed-packs.json`.
Gates load only those packs; a missing or invalid selection blocks. Each
selected pack contributes its delivery checks. `ts-web` requires a connected,
building UI. The separate `ts-service` pack requires a typed service, and when
both are selected the reachable UI client must use that service's router.

## Why

Run 29 showed that green tests could coexist with an unbuilt UI and a missing
service. Making composition explicit and checking each selected layer at
delivery closes both gaps while keeping local web apps valid.

## Consequences

Harness setup and existing projects must record their intended packs before
gates run. Project-specific rules and obligations come only from that list;
core owns the generic composition and delivery mechanisms, while packs own
stack-specific checks. `bounded compose` selects packages without regenerating
project files.
