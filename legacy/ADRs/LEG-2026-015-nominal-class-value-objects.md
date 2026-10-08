# LEG-2026-015: Value objects are nominal classes; branded aliases are banned

**Status:** superseded by LEG-2026-059

## Decision

The only value-object form a contract may declare is the nominal class: a
private `__brand` field whose literal matches the class name, a private
constructor, `static parse(raw: unknown): T | undefined`, readonly public
fields. Branded type aliases (`string & { __brand: … }`) are banned in both
optional- and required-brand forms (`no-branded-aliases`, run at
contract-purity).

## Why

Two runs supplied the evidence. The optional brand enforces nothing — every
bare string is assignable — and because no class exists, the value-object
shape rule, the generated law suite, and the boundaries obligation all stay
silent: a question mark disarmed the entire coverage machinery (Run 9, where
an agent under gate pressure chose exactly this form "to avoid forced type
assertions"). The required brand is incoherent under the escape-hatch regime
(ADR LEG-2026-016): `raw as Isbn` is its only constructor and `as` is banned in
src with no exemptions — a contract demanding what the implementer cannot
legally write. The class has a real constructor; it is the only form that
needs no escape hatch, which is why it is canonical rather than preferred.

## Consequences

`new-value-object.ts` emits the class and upgrades aliases in place. The
`__conformance` object cannot check nominal classes; surface conformance is
enforced semantically instead (surface-check, in the green gate and shipped
into delivered repos). Equality laws must not forbid interning — a cached
instance is a legitimate implementation.
