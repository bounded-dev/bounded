// Path policy for the developer-stage pipeline (TN-26-001).
//
// Pure core: no pi imports, no fs. The tool_call path-gate extension
// (Phase 2) is thin wiring over decide(). Every block returns a stable,
// one-line, greppable reason — a deterministic system that is opaque when
// it jams is just a deterministic jam.

import picomatch from "picomatch";
import type { TicketWriteScope } from "./ticket-design.ts";

export type Role = "architect" | "test-writer" | "builder" | "reviewer";

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export interface Ctx {
  /** Absolute path of the project root tool paths resolve against. */
  readonly cwd: string;
  /**
   * Absolute path of the harness config home (`~/.pi/agent`), when known.
   *
   * Only used to let a role READ skill instructions — its own, and those
   * shipped by installed packs and extensions. Omit it and nothing outside the
   * project opens up.
   */
  readonly harnessRoot?: string;
  /** Resolved by the host's filesystem boundary; absent in legacy projects. */
  readonly ticketScope?: TicketWriteScope;
  /**
   * Globs of the project's contract files (`src/**\/*<suffix>` for each
   * suffix the composed packs contribute, ADR 2026-052). They become the
   * architect's extra write zone, the test-writer's read exception inside
   * its blind src/ zone and the builder's write deny. Absent means no pack
   * contributes a suffix, so no file is a contract. `"unreadable"` means the
   * composition could not be read: the architect may not write under src/,
   * the test-writer gets no exception and the builder may not write under
   * src/ at all, so an unknown contract cannot be overwritten.
   */
  readonly contractGlobs?: readonly string[] | "unreadable";
  /**
   * Names the composed packs protect at ANY depth (ADR 2026-054): their
   * dependency directory names and their nested config file names. A nested
   * dependency directory or package manifest inside a role's zone is resolved
   * by the stack's tools before the project root's, so a role that could
   * write one could replace a dependency or re-configure a gate. Absent means
   * no pack contributes a name. `"unreadable"` means the composition could not
   * be read, and every write is refused (fail closed): which names are
   * protected is unknown.
   */
  readonly writeProtection?: WriteProtection | "unreadable";
}

/** Pack-contributed names write-denied for every role at any depth. */
export interface WriteProtection {
  /** Directory names (literal, compared case-insensitively). */
  readonly dirNames: readonly string[];
  /** File-name globs (`*` only, compared case-insensitively). */
  readonly fileNames: readonly string[];
}

const ALLOW: Decision = { allow: true };

// Skill files are the agent's own instructions: they say nothing about the run,
// so reading one leaks neither the tests nor the implementation. Every dogfood
// run so far opened with the architect trying to read its own SKILL.md and
// being refused — a side effect of the generic "outside the project root" rule,
// never a deliberate policy.
//
// Narrow on purpose. The harness root also holds `auth.json` (credentials),
// `sessions/` (transcripts of every other session on this machine), `missions/`
// and `run-history.jsonl`, so opening the directory wholesale would be a real
// leak. Allow the instruction content only, and only for reads.
//
// Run 7 found the other half of the same block. The architect read
// `packs/ts/skills/ts-contract-authoring/SKILL.md` from an absolute path
// happily, then asked for `npm/node_modules/pi-subagents/skills/pi-subagents/
// SKILL.md` — the documentation for the `subagent` tool it drives the entire
// pipeline with — and was refused, because an INSTALLED pack lives under
// node_modules rather than `packs/`. Same kind of file, same read-only need,
// opposite answer; it then spent two turns guessing `runs.run` and resume
// semantics out loud rather than looking them up.
//
// The installed arm is deliberately narrower than the harness's own `skills/**`.
// node_modules is a code tree, so it allows PROSE only (`.md`) and only under a
// `skills/` directory: a dependency's source stays as shut as the harness's own
// source. `**` before `skills/` is what admits scoped packages (`@acme/pack`).
//
// Run 29 found the third instance: a pack's `reference/` component (TN-26-008),
// which the skills point every role at ("copy this shape"), was refused because
// it is not under `skills/`. A reference is the same read-only, run-neutral kind
// of file as a skill — it is meant to be read and copied — so `packs/*/reference/**`
// joins the list. Same narrowness: only under a pack's `reference/`, never the
// pack root.
const HARNESS_READABLE = [
  "skills/**",
  "packs/*/skills/**",
  "packs/*/reference/**",
  "npm/node_modules/**/skills/**/*.md",
  "extensions/**/skills/**/*.md",
] as const;

/** Is `raw` a harness skill file this role may read? Read-only, never write. */
function isHarnessSkillRead(raw: string, tool: string, ctx: Ctx): boolean {
  const root = ctx.harnessRoot;
  if (root === undefined || !READ_TOOLS.has(tool)) return false;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  if (raw !== base && !raw.startsWith(base + "/")) return false;
  // Resolve `..` against the harness root before matching, so a path that
  // merely starts inside skills/ cannot climb out to auth.json.
  const inner = normalize(raw, base);
  if (!inner.ok) return false;
  return matchesAny(HARNESS_READABLE, inner.path);
}
const block = (reason: string): Decision => ({ allow: false, reason });

// --- Tool classes -----------------------------------------------------------

const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);
const READ_TOOLS = new Set(["read", ...SEARCH_TOOLS]);
// `remove` is write-class: deleting a file mutates the tree exactly like
// overwriting it, so it obeys the same write zones. It exists because Run 8's
// test-writer, asked to delete its own broken test file, COULD NOT — write and
// edit cannot remove — and the architect fell back to `git clean -f` on a file
// in another role's zone, which is worse than either role deleting inside its
// own.
const WRITE_TOOLS = new Set(["write", "edit", "remove"]);
const GATED_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS]);

// Backup layer under the frontmatter allowlist. Two tiers, because the roles
// are no longer symmetric: the architect drives a whole ticket and needs
// capabilities the two blind roles must never hold.
//
//   · `bash` — forbidden to EVERY role, architect included. A shell defeats
//     every path rule at once, so the architect gets named tools for what it
//     legitimately needs (the gates, git) rather than a way to run anything.
//     This is the difference between a wall and a suggestion.
//   · `subagent` and `git` — the architect's alone. It commissions the two
//     blind roles, and it does the archaeology (reflog, bisect, blame) that a
//     closed verb list would cage exactly when it is most needed.
//
// git is the sharper exclusion of the two: `git show HEAD:tests/x.test.ts`
// hands the builder the test source in a single call and `git log -p` does it
// by accident, so full git in a blind role's hands defeats blindness more
// completely than bash would.
//   · `run_tests` — the BUILDER's alone. It is the blind-safe debugging channel
//     for the one role implementing against a suite it cannot read. The
//     architect can read the tests and holds red_gate and green_gate; the
//     test-writer has no business running the implementation.
//
// That last one closes a drift rather than adding a rule: ROLE_TOOLS has always
// said run_tests is builder-only, but nothing enforced it, because run_tests is
// not a PATH tool and the gate only inspected those. The frontmatter allowlist
// binds subagents; a session launched from `.bounded/dev-stage-role` has none, so
// there the allowlist was documentation and Run 6's architect duly called it.
//   · `record_design_review` — the REVIEWER's alone, for the same reason
//     run_tests is the builder's: it is one role's channel, and handing it to
//     another empties it of meaning. A review the architect records of its own
//     spec is not a second reading of it, and the whole reason the role exists
//     is that the first reading already happened.
/**
 * The architect's tools that are NOT gates: they decide nothing and block
 * nothing, so they are kept out of `GATE_TOOLS`, where "a gate" means "a
 * verdict a phase can turn on".
 *
 *   · `sleep` — the wait primitive. The ROLE_TOOLS block below says what its
 *     absence cost r15.
 *   · `mutation_score` — the standing version of TN-26-002's hand-run mutation
 *     matrix. Advisory by construction: it reports a number and never a
 *     verdict, because the distribution real runs produce is not yet known and
 *     a threshold set before that is a guess wearing a uniform.
 */
export const ARCHITECT_UTILITY_TOOLS: readonly string[] = ["sleep", "mutation_score"];

const FORBIDDEN_ALL_ROLES = ["bash"] as const;
const ARCHITECT_ONLY_TOOLS = ["subagent", "git", ...ARCHITECT_UTILITY_TOOLS] as const;
const BUILDER_ONLY_TOOLS = ["run_tests"] as const;
const REVIEWER_ONLY_TOOLS = ["record_design_review", "change_diff"] as const;

/**
 * Tools each role may not call — the backup layer, and now also the input to
 * the STRIP: a bound session removes exactly this set from the model's visible
 * toolset at session start (src/path-gate.ts, hosts/pi/extensions/path-gate.ts), so the
 * refusals below are a backstop rather than the working mechanism.
 */
export const FORBIDDEN_TOOLS: Record<Role, ReadonlySet<string>> = {
  architect: new Set([...FORBIDDEN_ALL_ROLES, ...BUILDER_ONLY_TOOLS, ...REVIEWER_ONLY_TOOLS]),
  "test-writer": new Set([
    ...FORBIDDEN_ALL_ROLES,
    ...ARCHITECT_ONLY_TOOLS,
    ...BUILDER_ONLY_TOOLS,
    ...REVIEWER_ONLY_TOOLS,
  ]),
  builder: new Set([
    ...FORBIDDEN_ALL_ROLES,
    ...ARCHITECT_ONLY_TOOLS,
    ...REVIEWER_ONLY_TOOLS,
  ]),
  reviewer: new Set([
    ...FORBIDDEN_ALL_ROLES,
    ...ARCHITECT_ONLY_TOOLS,
    ...BUILDER_ONLY_TOOLS,
  ]),
};

// --- Role tool allowlists (frontmatter source of truth) ----------------------
// The tool allowlist is the ONLY enforcement layer that PREVENTS rather than
// detects (TN-26-001 §"Blindness and enforcement", layer 1): a capability an
// agent never holds cannot be misused, whatever the prompt says. These arrays
// are the canonical data; each pipeline agent's frontmatter `tools:` must equal
// its role's entry here (asserted by agent-config-drift.test.ts), and the
// orchestrator never grants a worker `subagent` or `bash`. Rationale:
//
//   · No `bash` for any worker — shell access defeats every path rule (a
//     builder could `cat tests/`, an architect could read `src/`). The builder
//     sees test FAILURES, never test SOURCE, through the sanitized `run_tests`
//     tool instead of a shell.
//   · No `subagent` for any worker — only orchestrators orchestrate; a worker
//     that could spawn subagents could launder its blindness through a child.
//   · `run_tests` is builder-only — the blind-safe debugging channel for the
//     one role implementing against a hidden suite. The architect and
//     test-writer never run the suite; the orchestrator runs the red/green
//     gates itself and never trusts a worker's word on pass/fail.
//   · `record_design_review` is reviewer-only, and it is the reviewer's ONLY
//     pen. The role reads the spec and the contracts before they are frozen
//     and writes nothing at all: its output is one guard event, checksum-bound
//     to the exact bytes it read. Giving it a write zone would make it a second
//     architect; giving the architect the tool would make the review a
//     self-review, which is the thing that was already tried.
//   · `typecheck` for all four — types are the contract's shared language;
//     every role must be able to confirm its own work compiles, and it is how
//     the reviewer checks a claim against the real tree rather than asserting
//     it (read-only: a type check touches nothing).
//   · The GATE TOOLS are the architect's alone, and they exist so it never
//     needs a shell. Each is thin wiring over an already-tested pack module,
//     which also removes a documented waste: dogfood Run 4's orchestrator
//     spent its first ~3 minutes `find`-ing the pack and `head`-ing three gate
//     scripts to work out how to invoke them. A tool schema cannot be
//     mis-invoked that way, and every call lands in the guard log — so "did
//     the architect actually run the gate" becomes checkable, not trusted.
//   · `sleep` and `mutation_score` are the architect's two NON-gate tools, and
//     they are its alone for the same reason the gates are: only the role that
//     orchestrates has anything to wait for, and only the role that reads both
//     sides has any use for a measurement of the suite. An earlier version of
//     this file said no `sleep` was reachable by anyone, because Run 4's
//     orchestrator had run `sleep 90` then `sleep 60` through a shell it no
//     longer has. r15 showed what removing the shell actually removed: with a
//     stalled reviewer and no wait primitive, its architect ran `design_gate`
//     five times as a clock — four junk scaffolds, and a gate record that no
//     longer described the project. A capability an agent genuinely needs does
//     not disappear when you take the tool away; it reappears wearing the
//     costume of a tool that is still there. So `sleep` is a named tool with
//     bounds and a guard-log line, and the gates stay claims about the project.
export const GATE_TOOLS: readonly string[] = [
  // The cheap single check, for iterating on a contract before the phase is
  // ready to advance.
  "contract_purity",
  // The whole DESIGN phase in one call: purity → scaffold → typecheck →
  // design-review-freshness → freeze (ADRs 2026-019/020). The steps had a
  // mandatory order that lived in prose,
  // and prose executes unreliably: separate `scaffold` and `freeze_contracts`
  // tools cost 3–6 minutes of round-trips per ticket and produced ordering
  // fumbles. They are steps of a sequence, so they are not tools.
  "design_gate",
  "check_drift",
  "red_gate",
  "generate_artifacts",
  "green_gate",
  // Green is not the terminal verdict: after it passes the architect records
  // what it saw reading both sides, and an empty list is a valid answer. Run 7
  // found a real defect in its closing turn and shipped anyway, because a gate
  // verdict was the only way the loop could end.
  "sign_off",
  // The delivery pass: the produced repo must not ship red-phase scaffolding
  // and must enforce its own contracts once the harness is gone.
  "deliver",
];

/**
 * Every pi tool that is an ARTIFACT GATE (ADR 2026-034): the architect's
 * gates above plus the measurement and the worker gates. This is the set the
 * gate registry exposes as tools and a second host reaches through
 * `bounded gates`; "which tools are not gates" is derived from it, never listed
 * again. `sleep`, `git`, `subagent`, `remove` and the file tools are host
 * capabilities and stay out.
 */
export const ARTIFACT_GATE_TOOLS: readonly string[] = [
  ...GATE_TOOLS,
  "change_diff",
  "mutation_score",
  "typecheck",
  "run_tests",
  "record_design_review",
];

export const ROLE_TOOLS: Record<Role, readonly string[]> = {
  architect: [
    "read",
    "grep",
    "find",
    "ls",
    "write",
    "edit",
    "remove",
    "typecheck",
    "subagent",
    "git",
    ...ARCHITECT_UTILITY_TOOLS,
    ...GATE_TOOLS,
  ],
  "test-writer": ["read", "grep", "find", "ls", "write", "edit", "remove", "typecheck"],
  builder: ["read", "grep", "find", "ls", "write", "edit", "remove", "run_tests", "typecheck"],
  // No write, no edit, no remove: the reviewer holds no pen but its own. It is
  // commissioned on the spec and the contracts BEFORE they are frozen, and the
  // only mark it leaves is the guard event `record_design_review` writes.
  reviewer: ["read", "grep", "find", "ls", "change_diff", "typecheck", "record_design_review"],
};

// Denied for every role, both directions.
const ALWAYS_DENY = [".git", ".git/**"] as const;

// Denied for every role on WRITE only. `.bounded/` holds the guard log and the
// contract-checksum manifest — the audit trail and the drift evidence. Every
// role must be able to READ them (diagnosing a jam, citing the log when
// escalating) and none may WRITE them, or the record of what happened becomes
// something the accused can edit. The gates write these files through plain
// `fs`, which never passes through the tool hook, so they are unaffected.
const ALWAYS_WRITE_DENY = [".bounded", ".bounded/**"] as const;

// Denied for every role on WRITE, the test-writer included — and the test-writer
// is the whole reason this is stated rather than inherited, because `tests/**`
// is its write zone.
//
// `tests/generated/**` is the value-object law suite: generated from the
// contract by the pack's `value-object-laws.ts`, asserting what is true of
// EVERY value object (parse refuses `null`/`[]`/`42`/`""`, equality is by
// value, parsing is deterministic). Nobody hand-writes it for the same reason
// nobody hand-writes a skeleton — an
// edit to a generated file is a claim the next regeneration silently discards,
// and a test suite that quietly reverts is worse than no suite. Reads are
// untouched: whoever can read `tests/` can read this.
const GENERATED_WRITE_DENY = ["tests/generated", "tests/generated/**"] as const;

// Directory names no role writes at ANY depth. The root `.git` and `.bounded`
// are denied above; a nested one is the same kind of thing in a place tools
// also honour (a nested `.git` is a repository boundary for git, a nested
// `.bounded` is harness state for whatever resolves the nearest one), so
// neither may appear inside a role's zone. Compared case-insensitively, as
// every path in this file is.
const CORE_PROTECTED_DIRS: ReadonlySet<string> = new Set([".git", ".bounded"]);

/** A `*`-only file-name glob as an anchored, case-insensitive expression.
 *  The names are pack data validated to `[A-Za-z0-9._*-]` (pack-contrib.ts),
 *  so nothing but `*` is special. */
function nameGlob(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
}

/** Write-denied for every role, whatever their zone says. Consulted by both
 *  decide() and ownerOfPath(), so routing can never name a role the gate would
 *  then refuse. */
function alwaysWriteDenied(
  path: string,
  protection: WriteProtection | "unreadable" | undefined,
): { readonly reason: string } | null {
  if (matchesAny(ALWAYS_WRITE_DENY, path)) {
    return {
      reason: "'.bounded' is the guard log and checksum manifest — read-only for every role",
    };
  }
  if (matchesAny(GENERATED_WRITE_DENY, path)) {
    return {
      reason:
        "'tests/generated' is machine-generated — the value-object law suite, written by the pack's value-object-laws.ts from the contract. Regenerate it; a hand edit is discarded, never merged",
    };
  }
  const segments = path.split("/");
  const lower = segments.map((segment) => segment.toLowerCase());
  const core = lower.findIndex((segment, i) => CORE_PROTECTED_DIRS.has(segment) && i > 0);
  if (core !== -1) {
    return {
      reason: `'${segments[core]}' is version control or harness state at any depth — no role writes one; report what needs changing to the orchestrator`,
    };
  }
  if (protection === "unreadable") {
    return {
      reason: "the project composition is unreadable, so the names its packs protect are unknown — every write waits; report it to the orchestrator",
    };
  }
  if (protection === undefined) return null;
  const dirs = new Set(protection.dirNames.map((name) => name.toLowerCase()));
  const dir = lower.findIndex((segment) => dirs.has(segment));
  if (dir !== -1) {
    return {
      reason: `'${segments[dir]}' is a dependency directory at any depth (ADR 2026-054): the stack's tools resolve a nested one before the project's installed dependencies — no role writes one; a dependency the project needs is a pack pin`,
    };
  }
  const name = segments[segments.length - 1]!;
  const glob = protection.fileNames.find((pattern) => nameGlob(pattern).test(name));
  if (glob !== undefined) {
    return {
      reason: `'${name}' is project config at any depth (ADR 2026-054, matches '${glob}'): the stack's tools read the nearest one per directory — no role writes it; report what needs changing to the orchestrator`,
    };
  }
  return null;
}

// --- Zones (v1: hardcoded globs, per TN-26-001) ------------------------------

export interface Zone {
  /** Write is an allowlist: only the role's own artifact kind. */
  readonly writeAllow: readonly string[];
  readonly writeDeny: readonly string[];
  /** Read is a denylist: everything except the role's blind zones. */
  readonly readDeny: readonly string[];
  /** Exceptions within readDeny (e.g. architect may read contracts). */
  readonly readExcept: readonly string[];
}

// WHAT BLINDNESS ACTUALLY IS (corrected after dogfood Run 5)
//
// The blindness is between TESTS and IMPLEMENTATION, and nowhere else:
//
//     artifact          architect   test-writer   builder
//     contract          read        read          read     ← shared
//     spec.md           read        read          read     ← shared
//     implementation    –           –             write
//     tests             –           write         –        ← the real blindness
//
// The contract and the spec are the SHARED interface: all three roles work
// against them, and they are declaration-only by construction (contract-purity
// enforces it), so sharing them leaks nothing. An earlier version of this file
// stated the rule as "src is ALWAYS blind, contracts included", which is a
// muddled reading of the same idea — and it killed a live run, because the
// test-writer imports from contract paths it was then refused permission to
// read. It escalated, was told the wall was intentional, and exited without
// writing a test.
//
// So: deny an agent the OTHER SIDE's work product. Never deny it the interface
// it is working against.
export const ZONES: Record<Role, Zone> = {
  // The architect owns one ticket end to end: it designs, commissions the two
  // blind roles, and arbitrates between them. So it READS EVERYTHING and WRITES
  // ALMOST NOTHING.
  //
  // This is not a hole in the blindness — it is where the blindness is aimed.
  // The failure the separation exists to prevent is one agent making a test
  // agree with an implementation, and a role that can write NEITHER cannot
  // commit it. Meanwhile the architect must read both: arbitrating "this test
  // contradicts the spec" is impossible without reading the test, and
  // answering "why is this failing?" is the human's whole reason for talking
  // to it. An empty readDeny also leaves no pipeline blind zone for a search
  // to overlap, so this role stops tripping most of issue #8's friction —
  // `ls src` and `ls tests` now work. Root `ls .` still blocks, but on the
  // `.git` overlap alone, which wants result filtering rather than a wider
  // zone.
  architect: {
    // Contract files are NOT listed here: the composed packs contribute their
    // suffixes, and zoneFor() adds `src/**/*<suffix>` from Ctx.contractGlobs
    // (ADR 2026-052), so the core names no technology.
    //
    // No project configuration file is writable by the architect or any other
    // role (ADR 2026-054). The stack's compiler, package and test-runner
    // config is generated from the composed packs' reference files and pins,
    // and some of it is loaded as code by the gates — so a role that could
    // edit it could change what a gate runs. A config diagnostic routes to
    // `orchestrator`; the remedy is the pack-owned config sync, run by the
    // user, or a pack change.
    writeAllow: [
      "spec.md",
      "docs/tn/TN-*.md",
      "CONTEXT.md",
      "ADRs/*.md",
      // The architect's sanctioned scratch zone. THREE runs, three models each
      // tried to write a throwaway type-probe (scratch-nominal-check.ts,
      // src/__probe/probe.ts, src/scratch-probe/…) to test a type idea, and each
      // was refused because it fell outside every write zone — then one smuggled
      // it in as a real contract, polluting the deliverable and costing ~10min of
      // cleanup. So the architect gets a legitimate sandbox. It is TOP-LEVEL, not
      // under src/ or tests/, precisely so it overlaps no artifact zone: every
      // gate that globs the project is rooted at src/ (contract-purity,
      // surface-check) or skips it by name (the checksum/freeze walk and the
      // scaffolder share IGNORE_DIRS in checksum-gate.ts), the scaffolded
      // compiler config includes only src/ and tests/ so a broken probe cannot
      // block a gate typecheck, deliver walks src/ and tests/ only so it never ships it,
      // and dogfood-reset gitignores it. Only the architect writes it — the three
      // blind roles' zones do not include it — so it is the architect's alone.
      "scratch/**",
    ],
    writeDeny: [],
    readDeny: [],
    readExcept: [],
  },
  // The contract is the interface under test, so the test-writer must be able
  // to read it — it imports from those exact paths. Dogfood Run 5 died here:
  // the task prompt told the test-writer to import from the contract, the gate
  // refused the read, and the role escalated and exited without writing a
  // test. Contracts are declaration-only (the contract-purity gate enforces
  // it), so this leaks no implementation; blind to src/** means blind to the
  // IMPLEMENTATION, never to the interface. Searches over src/ remain denied:
  // a directory listing would reveal the implementation's shape.
  "test-writer": {
    writeAllow: ["tests/**"],
    writeDeny: [],
    readDeny: ["src", "src/**"],
    // The contract files are the composed packs' contribution: zoneFor()
    // adds Ctx.contractGlobs here (ADR 2026-052).
    readExcept: [],
  },
  builder: {
    writeAllow: ["src/**"],
    // Contract files are denied through Ctx.contractGlobs (zoneFor()).
    writeDeny: [],
    readDeny: ["tests", "tests/**"],
    readExcept: [],
  },
  // The reviewer reads the design as the two blind consumers will, and that is
  // all it does: EMPTY writeAllow, so every write, edit and remove is refused
  // whatever the path. Its findings are claims recorded in the guard log for
  // the architect to settle, never edits made over the architect's head — the
  // spec and the contract have exactly one author, and a reviewer that could
  // fix what it found would be a second one.
  //
  // Read is unrestricted for the same reason it is for the architect: judging
  // whether a contract can be consumed blind means reading everything a
  // consumer would (and `typecheck` lets it confirm a claim against the real
  // tree). It is no threat to the blindness because it writes nothing at all —
  // it cannot make a test agree with an implementation when it can write
  // neither.
  reviewer: {
    writeAllow: [],
    writeDeny: [],
    readDeny: [],
    readExcept: [],
  },
};

// --- Glob matching -----------------------------------------------------------
// picomatch: conventional globstar semantics, one
// pinned option. dot: true so wildcards match dotfile segments — otherwise
// e.g. builder writes to 'src/.env.example' would fall outside src/**.
// Zone patterns are a closed harness-owned vocabulary (literal segments,
// '*', '**'); paths are the untrusted input and are normalized lexically
// before matching. If zone globs ever become per-repo configurable, treat
// the pattern side as untrusted too and audit picomatch's full language
// (braces, extglobs) before enabling.

const matcherCache = new Map<string, (path: string) => boolean>();

function matchGlob(pattern: string, path: string): boolean {
  let m = matcherCache.get(pattern);
  if (!m) {
    // nocase: macOS and Windows filesystems are case-insensitive, so
    // case-sensitive matching is not merely unhelpful — it is wrong in both
    // directions. It refused the architect's `SPEC.md` when `spec.md` is
    // literally the same file (dogfood Run 6), and, far worse, it would let
    // `TESTS/orders.test.ts` slip past a `tests/**` denial and hand a blind
    // role the other side's work. Zone patterns are a closed harness-owned
    // vocabulary, so widening the match costs nothing and closes that hole.
    m = picomatch(pattern, { dot: true, nocase: true });
    matcherCache.set(pattern, m);
  }
  return m(path);
}

function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}

/** Literal prefix of a glob before its first wildcard segment. */
function globBase(pattern: string): string {
  const segs = pattern.split("/");
  const i = segs.findIndex((s) => s.includes("*"));
  return (i === -1 ? segs : segs.slice(0, i)).join("/");
}

/** Do the directory trees rooted at a and b overlap (either direction)?
 *  Case-insensitive for the reason matchGlob is: on macOS and Windows
 *  `.GIT` and `TESTS` are the same directories as `.git` and `tests`. */
function overlaps(a: string, b: string): boolean {
  if (a === "." || b === ".") return true; // project root contains everything
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
}

// --- Normalization (lexical only — no fs, no symlink resolution) --------------

type Normalized = { ok: true; path: string } | { ok: false; reason: string };

function normalize(raw: string, cwd: string): Normalized {
  if (raw.includes("\0")) return { ok: false, reason: "invalid path (NUL byte)" };
  let p = raw;
  if (p.startsWith("/")) {
    const root = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
    if (p !== root && !p.startsWith(root + "/")) {
      return { ok: false, reason: `absolute path outside project root (${cwd})` };
    }
    p = p.slice(root.length);
  }
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return { ok: false, reason: "path escapes project root" };
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return { ok: true, path: out.length === 0 ? "." : out.join("/") };
}

// --- Ownership (who may FIX a file) ------------------------------------------

/** Upstream-first: the order the pipeline produces artifacts (contract → tests
 *  → implementation), and so the order in which a defect should be repaired.
 *
 *  Total over Role on purpose, even though the reviewer can never match: it
 *  has no write zone, so it owns nothing and is never a route target. Keeping
 *  the list total is what stops a role that LATER gains a zone from being
 *  silently unroutable — a file no role owns routes to the driving session. */
export const ROLES_UPSTREAM_FIRST: readonly Role[] = [
  "architect",
  "reviewer",
  "test-writer",
  "builder",
];

/**
 * The role whose write zone owns `path` — i.e. the only role the path gate
 * would let repair it — or `null` when no pipeline role may write it (config,
 * build files, anything outside the project).
 *
 * Derived from the same ZONES that decide() enforces, so gate routing can
 * never drift from what the path gate actually permits. Input is a
 * PROJECT-RELATIVE path (type-check diagnostics are relativized before they get
 * here); absolute paths are unowned rather than guessed at.
 */
export function ownerOfPath(
  path: string,
  contractGlobs: readonly string[] | "unreadable" = [],
  writeProtection?: WriteProtection | "unreadable",
): Role | null {
  if (path.startsWith("/")) return null;
  const n = normalize(path, "/");
  if (!n.ok || n.path === ".") return null;
  // A file no role may write is unowned however well it matches a write zone —
  // routing a generated law suite to the test-writer would deadlock the loop.
  if (alwaysWriteDenied(n.path, writeProtection) !== null) return null;
  return (
    ROLES_UPSTREAM_FIRST.find((role) => {
      const zone = zoneFor(role, contractGlobs);
      return !matchesAny(zone.writeDeny, n.path) && matchesAny(zone.writeAllow, n.path);
    }) ?? null
  );
}

/** A role's zone with the pack-contributed contract globs applied: the
 *  architect's contract writes, the test-writer's contract reads, the
 *  builder's contract write deny (fail-closed to all of src/ when the
 *  contracts are unknown; the architect then gets no contract write). */
function zoneFor(
  role: Role,
  contractGlobs: readonly string[] | "unreadable",
): Zone {
  const zone = ZONES[role];
  if (role === "architect" && contractGlobs !== "unreadable" && contractGlobs.length > 0) {
    return { ...zone, writeAllow: [...zone.writeAllow, ...contractGlobs] };
  }
  if (role === "test-writer" && contractGlobs !== "unreadable" && contractGlobs.length > 0) {
    return { ...zone, readExcept: [...zone.readExcept, ...contractGlobs] };
  }
  if (role === "builder" && (contractGlobs === "unreadable" || contractGlobs.length > 0)) {
    return { ...zone, writeDeny: [...zone.writeDeny, ...(contractGlobs === "unreadable" ? ["src/**"] : contractGlobs)] };
  }
  return zone;
}

// --- decide() -----------------------------------------------------------------

function verb(tool: string): string {
  if (WRITE_TOOLS.has(tool)) return "write";
  if (SEARCH_TOOLS.has(tool)) return "search";
  return "read";
}

// --- Refusal ergonomics -------------------------------------------------------
//
// A refusal that only says "no" costs a full model turn and teaches nothing:
// the model retries a variant of the same call. Live runs measured the price —
// a directly-launched architect burned six consecutive turns on `bash`, one per
// attempt, plus one each on `run_tests` and friends, because nothing in the
// refusal pointed anywhere. Every message below therefore ends by naming the
// legal route FOR THIS ROLE, in one clause.
//
// The strip (src/path-gate.ts) is what stops these turns being spent at all;
// this is what a refusal says on the paths the strip cannot reach.

/** The role's own named, non-path tools — what it reaches for instead of a
 *  shell. Kept in step with ROLE_TOOLS by path-policy.test.ts. */
const NAMED_TOOLS: Record<Role, string> = {
  architect: "the git tool, the gate tools, or typecheck",
  "test-writer": "read/grep/find/ls and typecheck",
  builder: "read/grep/find/ls, run_tests, or typecheck",
  reviewer: "read/grep/find/ls, typecheck, or record_design_review",
};

/** One line: why the tool is refused, and what to use instead.
 *
 *  Exported for the host adapters (hosts/claude-code/bash-policy.ts): a shell
 *  command that is not a sanctioned carrier is refused with the same sentence
 *  the pi `bash` tool would get, so the two hosts never explain one rule two
 *  ways. */
export function forbiddenWhy(role: Role, tool: string): string {
  // The architect is the one role with a real substitute for each of these,
  // so it gets told the substitute rather than its general toolkit.
  if (role === "architect" && tool === "run_tests") {
    return "run_tests is the builder's blind-safe channel — run red_gate/green_gate instead, which run the suite and typecheck together";
  }
  if (role === "architect" && tool === "record_design_review") {
    return "record_design_review is the reviewer's pen — commission the reviewer with subagent instead; a review you record of your own design is not a second reading of it";
  }
  const because =
    tool === "bash"
      ? "no role holds a shell"
      : tool === "run_tests"
        ? "run_tests is the builder's blind-safe channel"
        : tool === "record_design_review"
          ? "record_design_review is the reviewer's pen"
          : `'${tool}' is the architect's`;
  return `${because} — use ${NAMED_TOOLS[role]}`;
}

export function decide(
  role: Role,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  ctx: Ctx,
): Decision {
  if (FORBIDDEN_TOOLS[role].has(tool)) {
    return block(`path-gate: ${role} may not use '${tool}': ${forbiddenWhy(role, tool)}`);
  }
  if (!GATED_TOOLS.has(tool)) return ALLOW;

  const raw = input["path"];
  if (typeof raw === "string" && isHarnessSkillRead(raw, tool, ctx)) return ALLOW;
  if (raw === undefined || raw === null || raw === "") {
    if (SEARCH_TOOLS.has(tool)) {
      return block(
        `path-gate: ${role} may not use unscoped '${tool}': pass an explicit path inside your zones`,
      );
    }
    return block(`path-gate: ${role} may not ${verb(tool)}: missing path`);
  }
  if (typeof raw !== "string") {
    return block(`path-gate: ${role} may not ${verb(tool)}: invalid path (not a string)`);
  }

  const n = normalize(raw, ctx.cwd);
  if (!n.ok) {
    return block(`path-gate: ${role} may not ${verb(tool)} '${raw}': ${n.reason}`);
  }
  const t = n.path;
  const v = verb(tool);
  const zone = zoneFor(role, ctx.contractGlobs ?? []);

  // Zone checks run before the .git catch-all: an overlap with the role's
  // blind zone is the more actionable reason for the agent.
  const gitBlocked = (): Decision | null => {
    const gitHit = SEARCH_TOOLS.has(tool)
      ? ALWAYS_DENY.some((g) => overlaps(t, globBase(g)))
      : matchesAny(ALWAYS_DENY, t);
    return gitHit
      ? block(`path-gate: ${role} may not ${v} '${t}': '.git' is denied for all roles`)
      : null;
  };

  if (WRITE_TOOLS.has(tool)) {
    if (role === "architect" && ctx.ticketScope) {
      const scope = ctx.ticketScope;
      if (/^docs\/tn\/TN-[1-9][0-9]*\.md$/i.test(t) &&
        t.toLowerCase() !== `docs/tn/tn-${scope.ticket}.md`) {
        return block(`path-gate: architect may write only ticket #${scope.ticket ?? "unselected"}'s TN`);
      }
      if (t.toLowerCase() === "spec.md") {
        return block("path-gate: ticket-numbered projects write their ticket TN, not root spec.md");
      }
      // Which files are contracts is the composed packs' contribution
      // (ADR 2026-052). When the suffixes could not be read at all, the
      // architect's only source zone is contracts, so all of src/ waits.
      const suffixes = scope.contractSuffixes;
      const lower = t.toLowerCase();
      const unknown = suffixes.length === 0 && scope.error !== undefined && lower.startsWith("src/");
      if (unknown || suffixes.some((suffix) => lower.endsWith(suffix))) {
        if (scope.error) return block(`path-gate: ${scope.error}`);
        if (!scope.contracts.includes(t)) {
          return block(`path-gate: contract '${t}' is not owned by ticket #${scope.ticket}`);
        }
      }
    }
    const alwaysDenied = alwaysWriteDenied(t, ctx.writeProtection);
    if (alwaysDenied !== null) {
      return block(`path-gate: ${role} may not write '${t}': ${alwaysDenied.reason}`);
    }
    const denied = zone.writeDeny.find((g) => matchGlob(g, t));
    if (denied) {
      return block(
        `path-gate: ${role} may not write '${t}': denied for ${role} (matches '${denied}') — that path is another role's; report what needs changing`,
      );
    }
    // A role with NO write zone is read-only by construction, and "outside
    // <role> write zones ()" would send it hunting for the zone it is inside.
    // Say the true thing instead, and name what it has instead of a pen.
    if (zone.writeAllow.length === 0) {
      return block(
        `path-gate: ${role} may not write '${t}': ${role} has no write zone — it is read-only, and records what it found with record_design_review`,
      );
    }
    if (!matchesAny(zone.writeAllow, t)) {
      return block(
        `path-gate: ${role} may not write '${t}': outside ${role} write zones — the ${role}'s writable surface is ${zone.writeAllow.join(", ")}`,
      );
    }
    return gitBlocked() ?? ALLOW;
  }

  if (SEARCH_TOOLS.has(tool)) {
    // Searching a directory that contains (or is inside) a blind zone leaks
    // it — block on overlap either way, unless the target itself is an
    // explicit exception (e.g. architect grepping a contract file).
    const hit = zone.readDeny.find((g) => overlaps(t, globBase(g)));
    if (hit && !matchesAny(zone.readExcept, t)) {
      return block(`path-gate: ${role} may not search '${t}': overlaps denied zone '${hit}'`);
    }
    return gitBlocked() ?? ALLOW;
  }

  // read (single path)
  const hit = zone.readDeny.find((g) => matchGlob(g, t));
  if (hit && !matchesAny(zone.readExcept, t)) {
    return block(`path-gate: ${role} may not read '${t}': denied zone '${hit}'`);
  }
  return gitBlocked() ?? ALLOW;
}
