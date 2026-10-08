# 2026-022: Two model tiers, named per project

**Status:** accepted

## Decision

The developer stage has four seats and two kinds of work, so it gets two model
parameters, not four. `<project>/.bounded/dev-stage-models.json` names them:

```json
{ "designModel": "<pi model pattern>", "workerModel": "<pi model pattern>" }
```

`designModel` runs the judgment seats — architect and reviewer. `workerModel`
runs the production seats — test-writer and builder. pi's model pattern carries
the thinking level as a `:suffix`, so one string sets both the model and how
hard it thinks; that is why the tier is the whole setting.

The role→tier mapping is **harness-owned** (it is a statement about what a seat
does, which does not vary by project); the values are **per-project** (which
model is worth its price depends on the codebase and the budget). A `tool_call`
hook injects the tier's pattern onto a pipeline-role spawn, and logs a
`model-tier` guard event so the transcript proves which seat ran on what.

**A configured tier beats a caller-passed model.** Where the project names a
tier for the seat, an explicit `model` on the spawn call is replaced, and the
discarded value is recorded in the guard event's summary and detail so a spawn
that tried to choose is visible. Seat models are harness-owned policy, and a
tier any spawn could decline is a suggestion — the prose-versus-mechanism
failure this harness exists to close. A caller's model still stands where the
project set no tier for that seat (committed at `ffe2731`).

**Absent means absent; unresolvable means stop.** The two are different
failures and they get different answers. Missing file, missing key, unreadable,
malformed: all mean "no override", with a warning at most — running a seat on
the session default produces a right result more slowly, which is not a reason
to stop, and unknown keys warn rather than pass silently, because
`design_model` doing nothing at all, invisibly, is the realistic failure. But a
tier the project **did** configure and the harness cannot resolve to a model is
a different thing. r15 is the receipt: a configured `kimi-k3:high` matched
nothing in the live registry, so injection skipped — correctly, since
pi-subagents throws on an unresolvable explicit model — and the spawn then went
ahead anyway, running a judgment seat on a model nobody chose, silently. So the
**phase gate refuses the spawn** when the role has a configured tier the
registry cannot resolve. The project stated an intent, the harness cannot
honour it, and substituting something else without saying so is exactly the
drift the tier exists to prevent. The refusal lives in the phase gate rather
than in the injector because the injector mutates arguments and never blocks;
one place decides whether a spawn may happen.

## Why

Runs 10–12 measured design quality tracking the model, and run duration
tracking the volume seats. Paying design prices for volume is how a 35-minute
run happens; paying volume prices for design is how a bad contract gets frozen.
The knob has to exist per project, and it has to be small enough that setting
it is one decision per side rather than four.

Model choice is not enforcement — it buys quality rather than guaranteeing it —
so it is configuration with a log line, not a gate.

## Consequences

Two gaps are deliberate, not oversights:

- **The root architect session is not tiered by this mechanism.** A session
  launched into a bound role was never spawned through the `subagent` tool, so
  nothing can patch its model; it is tiered at launch instead
  (`pi --model <designModel>`, which `bounded ticket` passes through).
- **`workflowScript` children are moot.** Such a spawn names its children
  inside a JavaScript string, so no role is readable and no tier can be chosen
  — and the phase gate refuses those spawns for pipeline roles anyway.
- **A resume cannot be tiered, and keeps the tier of its launch.** pi-subagents
  refuses a `model` on `action: "resume"` outright, so there is nothing to
  inject: the child's model comes from the persisted run record. That is fine
  when the launch was tiered and invisible when it was not, so a resume now logs
  a note rather than nothing at all — r15's kimi architect made twelve resume
  calls and not one of them left a `model-tier` event, which is twelve seats no
  reader could account for.

Adding a fifth seat forces a tier decision: a drift test pins `TIER_BY_ROLE`'s
keys to the path policy's roster. Supersedes the framing of issue #5 ("model
tiering", closed), which assumed a per-role model list.

## Change log

- 2026-09-22 — the tier reaches Claude Code too: the host's PreToolUse hook
  runs the same `planModelTier` core on every allowed pipeline spawn,
  translates the pattern into the Agent tool's vocabulary
  (`anthropic/claude-opus-5:high` → `opus`; the thinking suffix has no
  equivalent there and is dropped visibly), and replaces a caller-passed
  model loudly. A configured tier that host cannot run (a non-anthropic
  model) refuses the spawn — the r15 lesson, applied across hosts.
