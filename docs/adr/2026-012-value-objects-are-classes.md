# 2026-012: Value objects are classes, as in the example

**Status:** accepted. Supersedes the branded-string and plain-object
deviations of [ADR 2026-004](2026-004-namespaced-pack-ids.md) (a branded
pack id), [ADR 2026-005](2026-005-events-verdicts-dispatch.md) (frozen plain
objects with type-only brands; Role and ProjectPath as branded strings) and
[ADR 2026-009](2026-009-path-gate-pack.md) (a rule as a frozen plain object).

## Decision

- **Every value object is a class, as in the worked example.** Its
  `<concept>.contract.ts` declares a branded interface (`readonly __brand`,
  its value or fields, `equals(other)`, `toJSON()`) and a factory interface
  (`parse(raw: unknown): Result<X>` and any named constructors). Its
  `<concept>.ts` holds `class XImpl implements Contract.X` with a private
  constructor, then `export type X = Contract.X;
  export const X: Contract.XFactory = XImpl;`. A union of value objects
  (`Effect`, `Event`, `Verdict`) is a union of such classes, with a factory
  whose `parse` picks the class by `kind`.
- **The value objects:** `PackId`, `ProjectPath`, `Role`, `CallId`,
  `Command`, `Url`, `AgentName`, `ToolName`, `NamePattern` (a list's
  filter), `DecisionId`; the seven effects, `ToolUse`, `SessionStart`,
  `ToolResult`, `Allow` and `Refuse`, `WatchedPath`, `Decision` (a log
  record: a follow-up shares its decision's id, so it is a value, not an
  entity) and the path gate's `ProtectedPath`.
- **Equal by value, serialised as before.** `equals` compares values (a
  composite compares its wire forms); `toJSON` gives the primitive, or the
  plain object the value was before this decision, so decision logs,
  snapshots and anything crossing an adapter are byte-for-byte unchanged.
- **Made, frozen, trusted.** Each instance freezes itself. `parse` gives an
  instance its class made back as it is, so a re-check (dispatch, a tool
  result) costs nothing; an instance is recognised by a private class field,
  so an object that merely inherits from one is parsed as untyped data.
- **Strict typing is kept.** `PackId<Text>` is typed by its exact text
  (`packIdsFor("bounded")("core")` is a `PackId<"bounded/core">` whose
  `value` is `"bounded/core"`), so ownership checks still compile only for
  exact, declared dependencies. Text never stands in for a value object.
- **A point takes a value object's wire form.** A point's values are its
  check's result type; when that is a value object, a contribution (and the
  owner's own `values`) may give its wire form instead, the type its `toJSON`
  returns (`WireOf<Value>`), because the check parses every value at
  composition. So rules stay object literals (`{ match, deny, redirect }`),
  exactly typed, and readers get the class. No other type gains anything.
- **Not value objects:** closed literal unions (`ToolKind`, `Change`,
  `EffectKind`, `PathAccess`) are enumerations; packs, points, declarations
  and contributions are identity objects (ADR 2026-003) and a configuration
  is made by `defineConfig` (ADR 2026-010); point keys are property names;
  `Judgement`, `Entry` and the drift feature's port data are plain records.
  Text inside a value object (a verdict's reason, a rule's globs) is part of
  it, normalised by its class.
- **Ports keep text where it is the store's key.** `DecisionIds.next()`
  gives text the handlers parse into a `DecisionId` (an invalid id fails
  closed); `ShellSnapshots` keys snapshots by the call id's text.

## Why

The maintainer's rule: value objects should all be classes, like the example.
A branded string reads as `string & { … }` in every type and message, its
brand exists only in types, and a look-alike is one cast away; a class has
one shape, one place that makes it, and a run-time identity.

## Consequences

- Code reads a value object's text as `.value` (`effect.path.value`,
  `pack.id.value`), and compares ids with `equals` or by `.value`: two
  `packIdsFor` calls make two objects.
- Host adapters build events from wire forms (`EffectJSON`, `ToolUseJSON`)
  and let `ToolUse.parse` check them.
- `architecture.test.ts` refuses a type alias that brands a primitive, and a
  branded contract no class implements (the identity objects above
  excepted), so the deviation cannot return unnoticed.
