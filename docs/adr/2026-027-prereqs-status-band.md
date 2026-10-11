# 2026-027: The prereqs status band, a Claude Code plugin shipped in dist that draws `bounded/prereqs`'s status file

**Status:** accepted (the `prereqs-status-band` plan, its plan review, the
orchestrator's decisions made for the maintainer, and the builder's step-0
checks, each change agreed by the orchestrator). Ships in `bounded` 3.3.0,
unreleased, with [ADR 2026-026](2026-026-prereqs-status-snapshot.md) and no
version bump of its own. Amends [ADR 2026-016](2026-016-cli-app.md) (dist
carries a plugin folder's TypeScript source) and
[ADR 2026-019](2026-019-prereqs-pack.md) (its future work: the status widget
is this band).

The mod API is cited as `CC:<line>` for Claude Code 2.1.294's
plugin-authoring declarations (`types/claude-code.d.ts`) and `RM:<line>`
for their `reference.md`. The band was verified with the Claude Code then
installed, 2.1.296; the band's own check type-checks against the
declarations the running build lays, and refuses another build's.

## Context

The maintainer wants a widget in a Claude Code session that shows where the
work stands: the project's prerequisite rules in config order, each with its
requirement's status, and the next action that is blocked. It shows and
never holds a phase, and re-implements no rule. ADR 2026-026 has
`bounded/prereqs` write what the widget needs, after every finished tool
call and agent run, to `.bounded/prereqs/status.json`. A Claude Code mod
runs in an environment of its own with no Node and no timers (CC:14581-14590),
loads only its own files through `import` declarations (CC:20-24), and
reaches everything else through `$`.

## Decision

### Where it lives, and how a project loads it

- **The band is a folder of the Claude Code host app,
  `src/hosts/claude-code/prereqs-status-band/`, the plugin
  `bounded-prereqs-status-band`**, in the mod form (RM:9-14, CC:14-24):
  `.claude-plugin/plugin.json`; `hooks/hooks.json` naming one hooks module,
  `hooks/register.ts`, exporting `register(on)` (CC:9233-9244); the pure
  modules it imports, all in `hooks/`; and its state contract,
  `types/index.d.ts`. Plain `.ts`, no JSX: the element constructors
  `$.ui.resolve(e)` hands out are called as functions with `children` among
  their props (CC:3748-3756). Its files import each other without a suffix:
  Claude Code loads them so, and the engine's tsconfig, which does not allow
  `.ts` suffixes, type-checks them.
- **dist carries it as TypeScript source**, at
  `dist/hosts/claude-code/prereqs-status-band/`, copied by
  `src/build-dist.ts` from an explicit file list (its manifest, `hooks.json`,
  every module of `hooks/` and `types/index.d.ts`): Claude Code loads `.ts`
  itself. build-dist refuses a file in `hooks/` that the list does not name.
  `bun pm pack` keeps the folder's `.claude-plugin/`, so the package's
  `files` is unchanged. `plugin.json`'s `version` is bounded's lockstep
  version (`docs/releasing.md`). This amends ADR 2026-016: dist also carries
  a plugin folder's source, which Node never runs.
- **bounded does not install the band** (the orchestrator's decision). A
  project loads it with `claude --plugin-dir
  node_modules/bounded/dist/hosts/claude-code/prereqs-status-band` from its
  root, or by naming that folder's absolute path in
  `CLAUDE_CODE_PLUGIN_DIRS`, which is user-wide (the process environment or
  `~/.claude/settings.json`'s `env`, never a project's settings: RM:68).

### How it reaches the status

- **It reads `<session root>/.bounded/prereqs/status.json` with `$.fs` on
  every draw** (CC:3187-3240), the root from `$.session.root()`
  (CC:2748-2755). `$.fs.exists` first, so a missing file is told from an
  unreadable one without reading an error's text; then `$.fs.read`, which
  rejects for a file it cannot read (CC:3200). No `$.process.run` and no
  Node: a file read needs the fewest engine behaviours.
- **It parses the file by hand, with no library**: it cannot import
  `bounded` or zod. It checks the shape `bounded/prereqs`'s value object
  accepts, plus the file form's `projectRoot`, an absolute path: exact keys,
  types, the statuses, the three forms of a rule's `before`, ISO times by the
  same test as `DecisionTime`, each requirement listed once, each rule's
  `requirementKey` naming a listed requirement, and the value object's other
  invariants (`allows` exactly when the requirement holds; `filesMatched` 0
  only for a missing requirement; a `pendingRun` exactly when pending; a
  requirement's key the key of its agent and patterns). It checks no content
  rule of agent names, file patterns or program prefixes, which it only
  shows. A parity test holds it to `bounded/prereqs`: every snapshot the
  real adapter writes reads back whole, and each shape the value object
  refuses, the band refuses, naming the field.
- **`format` is read straight after `JSON.parse`, before anything else.**
  Text that is not JSON, or JSON that is not an object, is malformed, saying
  which; an object whose `format` is not `bounded-prereqs-status/1` (or that
  has none) is a format mismatch naming both formats and where to load the
  band from, whatever else the file holds.

### Freshness: never a stale status shown as current

- **The band keeps one value in `$.state`, `lastFinishSeenAt`** (the
  orchestrator's ruling): milliseconds from `$.clock.now()` (CC:3398-3405)
  when it last saw a finished tool call or agent run, freshness metadata
  for telling a stale file, not a phase. Its reference's `plugin` and `key`
  are literals in source, as the engine requires (CC:3361-3363). The
  manifest's state contract, `types/index.d.ts`, declares it in
  `PluginState` (CC:7719-7729): `claude plugin validate` refuses a state
  reference the contract does not declare, and a contract holding anything
  but types (`export {}` included).
- **The mark only moves forward.** On `classic.PostToolUse`,
  `classic.PostToolUseFailure` and `classic.SubagentStop` the band reads the
  time once, then reads the mark and its version; a mark at or after that
  time stops it; else it writes the time only while the mark stands at that
  version (`ifVersion`, CC:3373-3388), and reads again when another write
  landed first, at most five times. So two finishes whose writes land out of
  order leave the later time.
- **The mark comes before `next(e)`, and the band redraws after it.** A
  classic hook's chain is managed settings hooks, then hooks modules, then
  the other settings hooks (CC:1230-1243), so bounded's own hook (a project
  settings hook) runs beneath the band's `next(e)` and writes the snapshot,
  its reading begun after the mark, before that call resolves.
- **A SubagentStop marks only with a non-empty `agent_type`**
  (CC:12175-12181): bounded's hook records nothing for an empty one.
- **The freshness rule**, `readingStartedAt` against the mark: no mark, "no
  reading yet this session"; a reading begun at or after it, fresh; one
  begun before it, "updating" (no marks) while the mark is at most 30 s old,
  then unavailable. 30 s is above bounded's hook deadline (20 s), within
  which the snapshot is written, so a slow but working hook is never shown
  unavailable.
- **No reset on a resumed session.** `$.state` does not survive
  `claude --resume` (checked with `claude -p` and `--resume`: the value read
  back undefined at version 0), so a resumed session starts with no mark.
- **Redraws.** A 2-second `$.clock.every` redraw (CC:3426-3436), started by
  `session.start` (which fires again after a reload or a worker respawn,
  CC:4294-4305) and, when not running, by each finish hook, finds a late
  file. Each finish also asks for a redraw the moment the 30-second wait
  ends (`$.clock.after`), so "updating" turns into unavailable then. A
  module variable records whether the 2-second timer runs; it dies with the
  timer at a reload.
- **Time only through `$.clock`**: never `Date.now()` or an argument-less
  `new Date()`, so the plugin tests' mocked clock drives every timing.

### What it draws

- **A `ui.render` hook on `{ component: "AbovePrompt" }`** (CC:10180-10236),
  drawn on the terminal and the desktop (CC:10188), a column `Box` of one
  `Text` per line, each truncated at the edge. While a survey holds the band
  it passes (CC:10192).
- **The render steps, in order; each failure is one line, "prereqs status
  unavailable: <why>", with no mark:**
  1. No `bounded.config.ts`, `.js` or `.mjs` at the session root: it passes,
     drawing nothing of its own. The band keeps its own copy of the names,
     held equal to bounded's `PROJECT_CONFIG_NAMES` by a test; that list is
     now one constant in `bounded/adapters`, which the configuration loader
     and `bounded init` both read.
  2. No status file: "no status file at .bounded/prereqs/status.json: is
     bounded/prereqs selected, and bounded's Claude Code hook installed?"; a
     file it cannot read: that, with the error.
  3. The JSON and the format; 4. the shape, naming the first bad field.
  5. `projectRoot` against the session root, both resolved with
     `$.fs.stat(path, { resolve: true })` (CC:3241-3293): unequal, or either
     unresolved, "this status is for <projectRoot>, not <session root>".
  6. Freshness, as above. 7. An unread snapshot: its `why`.
  8. A read snapshot: "prereqs status as of HH:MM:SS UTC", one line per
     requirement in the snapshot's order, and the next line.
  9. Anything that throws reaches the render hook's `.catch`, which draws
     "prereqs status unavailable: the band could not draw: <message>", or,
     if even that fails, answers nothing, so the engine draws its own empty
     band (CC:1154-1162).
- **Each mark means one thing**, and only a fresh read snapshot draws one:
  `✓ <agent>  over <patterns> as they are now` (holds), `◷ <agent>  running
  since HH:MM:SS UTC` (pending), `✗ <agent>  stale: <patterns> changed
  since`, `· <agent>  not yet run` (missing), and `· <agent>  <patterns>
  match no file yet` for a requirement whose patterns match no file.
- **The next line** lists the rules in contribution order up to and
  including the first that is blocked, each "<action> needs <agent> ✓" or
  "✗", the action in `describeBefore()`'s words: "delegating to <agent>",
  "writing <pattern>", "executing <program and words>". None blocked: "→
  nothing is blocked". No rules: "bounded/prereqs has no rules in this
  project".

### Hooks never block

- **Every registration has a `.catch`** (CC:9257-9283). The classic hooks'
  handler is `next(e)`, which replays the chain's answer when the hook had
  called `next` and runs it once when it had not (CC:1164-1183), so a band
  that fails (its state write refused, say) never changes or blocks a
  classic event; each hook returns exactly what `next(e)` resolved to.
  `claude plugin validate` lists each classic hook as a gating hook with its
  `.catch`.
- **Every use of `$` is in `register.ts`**: the engine accepts `$` passed
  only to a function declared at the top of the same file. The other modules
  are pure.

### Types

- **`hooks/engine-subset.ts` types the part of `$`, `on` and the events the
  band uses**, with function-typed properties, so the workspace's own `tsc`
  checks the band without the engine's declarations. Its hooks are generic
  in the event, the chain's answer and the element type, so each takes the
  engine's own types when the engine calls it.
- **`tests/register.typecheck.ts` proves the subset is the engine's**,
  checked by `tsc` against the declarations Claude Code lays beside a plugin
  it loads (CC:5-8, CC:67-89): each hook and `.catch` handler type the
  band's `on` takes satisfies the engine's own for that event. Assigning the
  band's `register` to the engine's `Register`, as first planned, cannot
  check this: both `on`s are overloaded, and `tsc` relates two overloaded
  function types with their generics erased to `any`, so the assignment
  fails whatever the subset says.

### Verification: `bun run check:prereqs-status-band`

- **`scripts/check-prereqs-status-band.ts`, outside `bun run check`**,
  because it needs Claude Code. Without `claude` on `PATH` it stops at once
  (exit 2) and creates nothing. Otherwise, on a fresh temporary copy of the
  band's folder (without what Claude Code writes into it), removed whatever
  the outcome:
  1. `claude plugin validate`: fails on a non-zero exit or a gating hook
     without `.catch` (RM:62);
  2. `claude plugin test`: the plugin tests in `tests/*.test.ts`;
  3. `tsc -p` against the engine's declarations. Neither step above lays
     them, nor does a headless `claude -p`; an interactive load does. So the
     script takes them from the source folder, laid there by `claude
     --plugin-dir src/hosts/claude-code/prereqs-status-band`, and fails,
     saying so, when they are absent. Their first line names the build that
     wrote them (CC:1), which must be the installed `claude --version`, or it
     fails, saying to load the band once so they are rewritten.
- **The plugin tests' red evidence is `claude plugin test`'s own output**
  at their own commit, before the band existed: the red-first check runs
  `bun test`, and they run only under Claude Code. `bun test`, the root
  `tsc` and biome leave the plugin tests, the state contract and the
  engine-written files to the script; git ignores the engine-written
  `.claude-plugin/types/` and `tsconfig.json`.

### The band rule (`src/test/architecture.test.ts`)

- Every file of the band imports only files of the band, by relative path:
  no package, except `claude-code/testing` in `tests/*.test.ts` and a
  type-only `claude-code` import in `tests/register.typecheck.ts`; no
  `import()` call (a module holding one does not load, CC:24); and files in
  `hooks/` use no `Bun.`, Node's `process.`, `require(`, `setTimeout(`,
  `setInterval(`, `Date.now(` or `new Date()`. Its one declaration file is
  `types/index.d.ts`, which imports and exports nothing. The scans skip
  anything under `.claude-plugin/types/`.

## Alternatives rejected

- **A copy in the project's `.claude/skills/`, or a project marketplace.**
  Both rest on loading behaviour not verified, and a copy in the project is
  agent-writable and hot-reloaded.
- **Installing the band by default** (`bounded init`/`update`): putting
  early-access mod code into every bounded project, including ones without
  prereqs, is a larger decision than this item.
- **An installer flag**: new CLI surface, and an ADR 2026-015 change.
- **Reaching the status in-process through dist, or with `$.process.run`**:
  needs Node from the mod and more unverified engine behaviour than a file
  read.

**Future work:** install via `bounded init` once project-level plugin
loading is verified.

## Accepted

- The "updating" line after every finished call, until bounded's reading of
  it lands: a flicker, in exchange for never showing a reading older than
  the last finish as current.
- The status is as of the last finished call: during a long call the band
  shows the previous reading, with its time.

## Limits

What `claude plugin test` cannot reach, and what the band cannot see (also
in `docs/flight-state.md`):

- The real file read through `$.fs`: the plugin tests answer `$.fs` from a
  table of their own.
- Loading from `node_modules`: Claude Code writes `.claude-plugin/types/` and
  `tsconfig.json` into the folder it loads, here the installed package; a
  read-only or content-addressed store may refuse that.
- The band's clock and bounded's hook's clock agreeing: the mark is the
  band's, the reading's start the hook's.
- Timer liveness: the redraws die with a reload or a worker respawn and come
  back with `session.start` or the next finish; while they are dead,
  "updating" does not turn into unavailable, but it still draws no mark, so
  a dead timer never shows a status as current.
- The classic chain's order: were bounded's hook not to run beneath the
  band, the band would show "updating" until a redraw finds the file.
- Unseen finishes: a call interrupted with Esc fires no hook; a call bounded
  denied fires neither PostToolUse nor PostToolUseFailure; a SubagentStop
  with an empty `agent_type` is skipped; a plugin above the band that answers
  a classic event without `next` hides it; files changed outside Claude Code
  change nothing the band sees. In each case the band keeps showing the last
  reading, with its time, until the next finish it sees.
- `$.session.root()` against `CLAUDE_PROJECT_DIR`: after `/cd` they differ,
  and the band says unavailable.
- Under the user-wide `CLAUDE_CODE_PLUGIN_DIRS` load, a project with a
  bounded configuration but without `bounded/prereqs` (or without bounded's
  hook) shows "unavailable: no status file"; a project with no bounded
  configuration shows nothing.
- The parser checks shape, not content; the file is forgeable and decides
  nothing (ADR 2026-026).
- `$.state` was checked across `claude -p --resume` only; whether an
  in-process `/resume` keeps the mark is not verified. A kept mark is a
  finish the band really saw, so it can only make the band wait for a newer
  reading.
- A classic hook that fails is skipped by the engine even without a
  `.catch` (RM:74), so the plugin tests cannot tell the band's `.catch` from
  the engine's own skip: they show the answer passes through when the
  band's state write is refused, not which of the two passed it.

## Consequences

- A project that selects `bounded/prereqs` and loads the band sees each
  requirement's status and the next blocked action above the prompt, and
  "no reading yet", "updating" or "unavailable, <why>" whenever the status
  could be stale or wrong.
- The core gains one adapter-layer constant, `PROJECT_CONFIG_NAMES`, exported
  from the internal `bounded/adapters`; no core behaviour changes.
- A change to the band runs `bun run check:prereqs-status-band` before
  final review (`docs/development-workflow.md`).
