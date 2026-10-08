# 2026-029: Tickets name capability; the harness binds the stack

**Status:** accepted

## Decision

Incoming specs are **capability statements** — intake strips any embedded
"how" as a general rule of the stage (ADR 2026-032). This ADR is the stack
half: the stack that satisfies a capability is **harness policy**, one
blessed choice per capability per language, pack-pinned — as vitest is *the*
TS test runner: today, tRPC for "typed access for a frontend" and zod as the
schema engine (ADR 2026-031). Three layers bind it: a pack skill triggered
by capability language (guidance, best-effort); availability — targets
cannot add dependencies and the pack pins and installs the blessed stack, so
no other is reachable; and the `blessed-stacks-only` import lint, which
blocks non-allowlisted frameworks unconditionally. A ticket naming a
different stack is the ADR 2026-032 constraint case: challenged and routed
to the user, never silently obeyed.

## Why

Run 22 delivered a tRPC service only because the *prompt* named the stack
and carried the expertise — knowledge that must live in the harness, since
real tickets will not carry it. And a ticket that names a stack must not
leak one in: "expose over GraphQL" is a product sentence wearing a
technology decision, and honoring the word rather than the need would let
any ticket author overrule recorded policy by phrasing.

## Consequences

The reference structure (TN-26-004) lands identically whatever words the
ticket used. Stack changes happen exactly one way: a human changes the
policy. Guidance can fail without the binding failing — the dependency
allowlist and import lint hold even when no skill loaded.
