# 2026-012: Vendor third-party skills; pin subagent skills by name

**Status:** accepted

## Decision

Third-party skills (e.g. `flight-status` from `bounded-dev/skills`) are
**copied into `agent/skills/`** and kept in sync by hand, rather than loaded
from a sibling repo via a `packages` entry. The `../../bounded-dev/skills`
pointer is removed from `agent/settings.json`.

Subagents that need a specific skill **pin it by name** in their agent
frontmatter (`skills: <name>`) with `inheritSkills: false`, instead of
hardcoding an absolute path in the prompt body. Applied to
`agent/agents/product-expert.md`: `skills: product-expert`, and the body now
says "read the provided skill" with no path.

## Why

- **pi resolves local package/skill paths lexically against the `~/.pi/agent`
  symlink.** `resolvePath` uses `path.resolve`, which collapses `..`
  textually and never follows the symlink; the agent dir (`getAgentDir()`) is
  the symlink path, uncanonicalized. So `../../bounded-dev/skills` resolves to
  `~/bounded-dev/skills` (nonexistent), not the repo's real sibling. No
  relative pointer can be both correct under this resolution and independent
  of where the repos are cloned — the sister-dir convention is fundamentally
  incompatible with a symlinked agent dir. Vendoring sidesteps it entirely:
  `agent/skills/` is auto-discovered because it *is* `~/.pi/agent/skills/`.
- **Subagent skill availability is all-or-nothing otherwise.**
  `inheritSkills: false` strips the *entire* discovered catalog from the
  child (verified: the child sees an empty skills list). The hardcoded-path
  `read` was a workaround for that. Frontmatter `skills:` restores exactly one
  skill with its location injected by the harness — independent context
  preserved, no fragile path.
- **Subfolder-safe.** Skill discovery (`walkSkillDirectories`) is recursive
  and keys a skill by its **folder basename**, not path depth. So
  `skills: product-expert` keeps resolving if the skill later moves to
  `agent/skills/<category>/product-expert/`, as long as the leaf folder name
  is unchanged.

## Consequences

- `flight-status` lives at `agent/skills/flight-status/`; upstream edits in
  `bounded-dev/skills` must be re-copied manually (accepted cost).
- No sibling-repo clone in bootstrap; README/ADRs 2026-006/007/011 updated.
- Skill folders may be organised into category subdirectories later at zero
  cost — discovery is recursive and name-keyed.
- Worth reporting upstream: pi arguably should canonicalize the agent dir or
  resolve package `..` physically so symlinked config homes behave intuitively.
