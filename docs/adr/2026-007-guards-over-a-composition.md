# 2026-007: Guards over a composition: the core pack and per-effect dispatch

**Status:** accepted.

## Decision

- **The core pack.** `corePack` has the id `bounded/core` and is the one place
  the core declares extension points: `toolUseGuards` (whole calls, for
  example a tool allowlist), `sessionStartGuards`, and one point per effect
  kind: `readGuards`, `listGuards`, `writeGuards`, `executeGuards`,
  `fetchGuards`, `delegateGuards`, `invokeGuards`. Point keys are camelCase
  (ADR 2026-004), so `guards.read` is written `readGuards`. Each point's check
  refuses a contributed value that is not a function.
- **Typed by kind.** A whole-call guard is a `Guard<ToolUse>` (or
  `Guard<Event>`); an effect guard is an `EffectGuard<ReadEffect>` and so on:
  `(effect, composition, call) => Verdict`. A guard for one kind does not
  compile on another kind's point, and a pack contributing guards lists
  `corePack` in `dependsOn` (ADR 2026-003). The composition is the context, so
  a guard can read other packs' points; an effect guard also gets the whole
  call, so rules scoped to a role apply per effect.
- **Fan-out.** `dispatchEvent(composition, event)`: a session start runs the
  session-start guards; a tool use runs the whole-call guards, then each
  effect in order through the guards for its kind. Gates never handle one
  effect versus many. An effect kind with no guards is allowed. That includes
  `invoke`: a tool the host cannot describe passes unless a selected pack
  contributes `invokeGuards`. Adapter authors should map tools to precise
  effects wherever they can, and a pack that wants unknown tools refused
  must guard `invoke` explicitly. Guards run in
  pack composition order (dependencies first), then contribution order; the
  first refusal wins.
- **Provenance.** Composition keeps which pack contributed each value
  (`entries`). A refusal names the pack and, for an effect, the effect:
  "bounded/path-gate refused write (modify) src/x.ts: …"; a guard that fails
  is named the same way ("A guard from … for read a.ts threw: …").
- **The core pack is not implicit; without it dispatch refuses.** Selecting
  packs without the core is a misconfiguration, and the safe reading of it is
  "nothing can decide", so every event is refused with a message saying to
  select `bounded/core`. Adding the core silently would hide the mistake and
  make composition special-case one pack; packs that contribute guards must
  depend on it anyway, so a selection with any gate already needs it.
- **Only what it can trust.** Dispatch accepts only a composition made by
  `Composition.compose` in the same copy of the core; a look-alike object is
  refused. A guard that dispatches again is refused with a short reason
  rather than recursing. A refusal's reason and redirect are one line: control
  characters and line breaks (including U+2028, U+2029 and U+0085) become spaces, so a guard cannot forge a second
  "… refused" line, and text past 2,000 characters is shortened, saying so.
- **Every failure refuses.** As in ADR 2026-005, per guard call: a guard
  that is not a function, throws, returns a promise or anything but a
  verdict; plus an invalid event, something that is not a composition, and
  guard points that cannot be read. `dispatchEvent` never throws.

## Consequences

Guards stay synchronous (ADR 2026-005). The pure `dispatch(guards, event)`
remains for whole-event guards in a list; `dispatchEvent` is what host
adapters call.
