# 2026-047: Keep composed service and web green gates consistent

**Status:** accepted

## Decision

The web pack's client transport rule matches the client package and its
subpaths, leaving server imports to the service rule. The TypeScript surface
checker treats an exported implementation constant as contract-declared when
an exported contract type alias directly queries it with `typeof` through a
type-only import from that implementation sibling. Other implementation
exports remain subject to the undeclared-surface check.

## Why

A project composing service and web passed red and all live tests but could
not pass green: the web rule rejected generated server support, while the
surface checker rejected the inferred router value required by the service
capability. Both conflicts arose from rules disagreeing about ownership.

## Consequences

The server and client doors remain enforced by their owning packs. A contract
can name an inferred implementation value without inventing an incompatible
declaration for it; unrelated public exports still fail surface checking.
