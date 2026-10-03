// Path policy for the developer-stage pipeline (TN-26-001; the sides are
// source roots and file-name suffixes, ADRs 2026-056…058).
//
// Pure core: no pi imports, no fs — what the filesystem says reaches it only
// as data the host passes (Ctx.pathFacts). The tool_call path-gate extension
// (Phase 2) is thin wiring over decide(). Every block returns a stable,
// one-line, greppable reason — a deterministic system that is opaque when
// it jams is just a deterministic jam.

import picomatch from "picomatch";
import type { TicketWriteScope } from "./ticket-design.ts";
import { changeRunRoute } from "./ticket-route.ts";
import { pathGlobMatcher, sourceRootOf } from "./pack-contrib.ts";

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
   * Globs of the project's contract files (`<root>/**\/*<suffix>` for each
   * composed source root and contract suffix, ADRs 2026-052 and 2026-056).
   * They become the architect's extra write zone, the test-writer's read
   * exception and the builder's write deny. `"unreadable"` means the
   * composition could not be read: no file is known to be a contract, so the
   * architect writes none, the test-writer reads none and the builder may not
   * write inside any source root. Absent is treated as unreadable.
   */
  readonly contractGlobs?: readonly string[] | "unreadable";
  /**
   * The composed `sourceRoots` (ADR 2026-056): the directories roles author
   * source under. Absent or `"unreadable"` fails closed: every path that could
   * lie under some root is the OTHER side for both blind roles.
   */
  readonly sourceRoots?: readonly string[] | "unreadable";
  /**
   * The composed `testFileSuffixes` (ADR 2026-057): a file inside a source
   * root whose name ends with one is test-side. Absent or `"unreadable"`
   * treats every file under a root as the other side for both blind roles.
   */
  readonly testSuffixes?: readonly string[] | "unreadable";
  /**
   * The composed `generatedFileGlobs` (ADR 2026-058): write-denied for every
   * role, readable by every role. Absent or `"unreadable"` refuses every
   * write, because which files are generated is unknown.
   */
  readonly generatedGlobs?: readonly string[] | "unreadable";
  /**
   * What the filesystem says about a project-relative path, when the host can
   * look (the path gate can; a pure caller cannot). Only content search uses
   * it. Absent means "cannot tell", which is judged the strict way.
   */
  readonly pathFacts?: PathFacts;
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

/** Filesystem facts a host supplies for content search (see Ctx.pathFacts). */
export interface PathFacts {
  /** What a project-relative path is, following links. */
  kind(path: string): "file" | "directory" | "absent";
  /**
   * Everything below a project-relative directory, links not followed and
   * `.git` skipped: the base name of every non-directory entry, and the
   * project-relative path of every link — or undefined when the tree cannot
   * be listed in full. A content search is allowed over a directory only when
   * this is known and holds no link (a link could lead a search anywhere),
   * and a `!*<suffix>` exclusion is proven against these names whatever
   * their case.
   */
  tree(dir: string): PathTree | undefined;
  /**
   * Is the path's real location the path as written: no link anywhere on it,
   * and no case or Unicode folding? A path that does not exist is as written
   * (it reaches nothing); one that cannot be resolved is not. A names-only
   * listing or a shell content search runs on the path as the shell sees it,
   * so it is allowed only where this holds — a link could carry it into
   * `.git` or out of the project past every lexical check.
   */
  asWritten?(path: string): boolean;
}

/** What lies below a directory (see PathFacts.tree). */
export interface PathTree {
  readonly fileNames: readonly string[];
  readonly links: readonly string[];
  /** Project-relative paths of entries (files or directories) whose name
   *  has a non-ASCII character. */
  readonly oddNames: readonly string[];
}

/**
 * The layout data that decides who owns a file (ADRs 2026-056…058): the
 * source roots, the contract globs, the test-side suffixes and the generated
 * globs. Each field is the composed value or `"unreadable"`.
 */
export interface PathLayout {
  readonly sourceRoots: readonly string[] | "unreadable";
  readonly contractGlobs: readonly string[] | "unreadable";
  readonly testSuffixes: readonly string[] | "unreadable";
  readonly generatedGlobs: readonly string[] | "unreadable";
}

/** Every field unreadable: what a caller that passes no layout gets. */
export const UNREADABLE_LAYOUT: PathLayout = {
  sourceRoots: "unreadable",
  contractGlobs: "unreadable",
  testSuffixes: "unreadable",
  generatedGlobs: "unreadable",
};

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
// git is the sharper exclusion of the two: `git show HEAD:<a test file>`
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
//     builder could `cat` a test file, `grep -r` would read every one). The builder
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

// Generated files (ADR 2026-058) are denied for every role on WRITE, the
// test-writer included — a generated law suite is test-side by name, and the
// test-writer is exactly the role that would otherwise be let in. Nobody
// hand-writes one for the same reason nobody hand-writes a skeleton: an edit to
// a generated file is a claim the next regeneration silently discards, and a
// suite that quietly reverts is worse than no suite. Which files are generated
// is the composed packs' `generatedFileGlobs`; the core names none. Reads are
// open to every role: blindness guards the other role's AUTHORED work only.
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
  generated: readonly string[] | "unreadable",
): { readonly reason: string } | null {
  if (matchesAny(ALWAYS_WRITE_DENY, path)) {
    return {
      reason: "'.bounded' is the guard log and checksum manifest — read-only for every role",
    };
  }
  if (generated === "unreadable") {
    return {
      reason: "the project composition is unreadable, so which files are generated is unknown — every write waits; report it to the orchestrator",
    };
  }
  const glob = generated.find((g) => pathGlobMatcher([g])(path));
  if (glob !== undefined) {
    return {
      reason: `it is a generated file (matches '${glob}', ADR 2026-058) — a generator writes it from the design and a hand edit is discarded; read it freely, and report what should change to the orchestrator`,
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
  const config = protection.fileNames.find((pattern) => nameGlob(pattern).test(name));
  if (config !== undefined) {
    return {
      reason: `'${name}' is project config at any depth (ADR 2026-054, matches '${config}'): the stack's tools read the nearest one per directory — no role writes it; report what needs changing to the orchestrator`,
    };
  }
  return null;
}


// --- Zones -------------------------------------------------------------------

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
//     contract          write       read          read     ← shared
//     spec / TN         write       read          read     ← shared
//     generated         read        read          read     ← shared (ADR 2026-058)
//     implementation    read        –             write
//     tests             read        write         –        ← the real blindness
//
// The contract and the spec are the SHARED interface: all three roles work
// against them, and they are declaration-only by construction (contract-purity
// enforces it), so sharing them leaks nothing. An earlier version of this file
// stated the rule as "source is ALWAYS blind, contracts included", which is a
// muddled reading of the same idea — and it killed a live run, because the
// test-writer imports from contract paths it was then refused permission to
// read. It escalated, was told the wall was intentional, and exited without
// writing a test.
//
// So: deny an agent the OTHER SIDE's work product. Never deny it the interface
// it is working against.
//
// WHERE THE SIDES ARE (ADRs 2026-056, 2026-057). Tests sit next to the code
// they test, so the sides are told apart by FILE NAME, not by directory. Inside
// a composed source root, a file whose name ends with a composed test suffix is
// test-side, a contract is shared, a generated file is shared, and every other
// file is implementation. The core names no root and no suffix: the blind
// roles' static zones below are therefore empty, and decide() derives them
// from the layout the host passes in Ctx. A NAME is not content: either blind
// role may list and find the other side's file names; it may not read them,
// search their content, or write them.
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
  // to it. Root `ls .` still blocks, but on the `.git` overlap alone, which
  // wants result filtering rather than a wider zone.
  architect: {
    // Contract files are NOT listed here: the composed packs contribute their
    // roots and suffixes, and decide() adds Ctx.contractGlobs (ADRs 2026-052,
    // 2026-056), so the core names no technology and no layout.
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
      // tried to write a throwaway type-probe to test a type idea, and each
      // was refused because it fell outside every write zone — then one
      // smuggled it in as a real contract, polluting the deliverable and
      // costing ~10min of cleanup. So the architect gets a legitimate sandbox.
      // It is TOP-LEVEL, away from the source roots, so it overlaps no artifact
      // zone: the checksum/freeze walk and the scaffolder skip it by name,
      // deliver never ships it, and dogfood-reset gitignores it. Only the
      // architect writes it — no other role's zone includes it.
      "scratch/**",
    ],
    writeDeny: [],
    readDeny: [],
    readExcept: [],
  },
  // Writes test-side files inside the source roots; reads everything except
  // implementation files. Derived from the layout in decide().
  "test-writer": { writeAllow: [], writeDeny: [], readDeny: [], readExcept: [] },
  // Writes implementation files inside the source roots; reads everything
  // except test-side files. Derived from the layout in decide().
  builder: { writeAllow: [], writeDeny: [], readDeny: [], readExcept: [] },
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
  reviewer: { writeAllow: [], writeDeny: [], readDeny: [], readExcept: [] },
};

// --- Glob matching -----------------------------------------------------------
// picomatch: conventional globstar semantics, one pinned option. dot: true so
// wildcards match dotfile segments — otherwise a dotfile under a zone would
// fall outside it. Zone patterns are a closed vocabulary (literal segments,
// '*', '**': the harness's own and the contract globs pack-contrib builds from
// validated roots and suffixes); paths are the untrusted input and are
// normalized lexically before matching.

const matcherCache = new Map<string, (path: string) => boolean>();

function matchGlob(pattern: string, path: string): boolean {
  let m = matcherCache.get(pattern);
  if (!m) {
    // nocase: macOS and Windows filesystems are case-insensitive, so
    // case-sensitive matching is not merely unhelpful — it is wrong in both
    // directions. It refused the architect's `SPEC.md` when `spec.md` is
    // literally the same file (dogfood Run 6), and, far worse, it would let a
    // case-varied path slip past a denial and hand a blind role the other
    // side's work. Widening the match costs nothing and closes that hole.
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
 *  Case-insensitive for the reason matchGlob is: on macOS and Windows `.GIT`
 *  is the same directory as `.git`. */
function overlaps(a: string, b: string): boolean {
  if (a === "." || b === ".") return true; // project root contains everything
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
}

// --- Sides (ADR 2026-057) -----------------------------------------------------
//
// Each question below answers true, false, or undefined for "cannot tell" (the
// data it needs is unreadable). Every rule that uses one opens access only on
// a definite answer, so unreadable data always closes.

type Tri = boolean | undefined;

/** Is the project-relative path strictly inside a composed source root? */
function inSourceRoot(path: string, roots: readonly string[] | "unreadable"): Tri {
  if (roots === "unreadable") {
    // Every root has at least one segment and a path is inside a root only
    // when strictly deeper, so a top-level name is never inside one; nor is
    // anything under the two directories no root may name.
    if (path === "." || !path.includes("/")) return false;
    const first = path.slice(0, path.indexOf("/")).toLowerCase();
    return first === ".git" || first === ".bounded" ? false : undefined;
  }
  return sourceRootOf(path, roots) !== undefined;
}

/** Could a search rooted at `path` reach a file inside a source root? True
 *  when the path is inside a root, is a root, or lies above one. */
function reachesSourceRoot(path: string, roots: readonly string[] | "unreadable"): Tri {
  if (path === ".") return roots === "unreadable" ? undefined : roots.length > 0;
  const inside = inSourceRoot(path, roots);
  if (inside !== false) return inside;
  if (roots === "unreadable") {
    const first = path.split("/")[0]!.toLowerCase();
    return first === ".git" || first === ".bounded" ? false : undefined;
  }
  const segments = path.toLowerCase().split("/");
  return roots.some((root) => {
    const rootSegments = root.toLowerCase().split("/");
    return segments.length <= rootSegments.length &&
      segments.every((segment, i) => rootSegments[i] === "*" || rootSegments[i] === segment);
  });
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The composed test suffix a file name ends with, ignoring case. */
function testSuffixOf(path: string, suffixes: readonly string[]): string | undefined {
  const lower = baseName(path).toLowerCase();
  return suffixes.find((suffix) => lower.endsWith(suffix.toLowerCase()));
}

function isGenerated(path: string, globs: readonly string[] | "unreadable"): Tri {
  return globs === "unreadable" ? undefined : pathGlobMatcher(globs)(path);
}

function isContract(path: string, globs: readonly string[] | "unreadable"): Tri {
  return globs === "unreadable" ? undefined : matchesAny(globs, path);
}

/** Test-side: inside a root, named with a test suffix, not generated. */
function isTestSide(path: string, layout: PathLayout): Tri {
  const inside = inSourceRoot(path, layout.sourceRoots);
  if (inside === false) return false;
  if (isGenerated(path, layout.generatedGlobs) === true) return false;
  if (layout.testSuffixes === "unreadable") return undefined;
  if (testSuffixOf(path, layout.testSuffixes) === undefined) return false;
  return inside === true && layout.generatedGlobs !== "unreadable" ? true : undefined;
}

/** Implementation: inside a root, neither test-side, contract nor generated. */
function isImplementation(path: string, layout: PathLayout): Tri {
  const inside = inSourceRoot(path, layout.sourceRoots);
  if (inside === false) return false;
  if (isGenerated(path, layout.generatedGlobs) === true) return false;
  if (isContract(path, layout.contractGlobs) === true) return false;
  if (layout.testSuffixes !== "unreadable" && testSuffixOf(path, layout.testSuffixes) !== undefined) return false;
  const known = inside === true && layout.testSuffixes !== "unreadable" &&
    layout.contractGlobs !== "unreadable" && layout.generatedGlobs !== "unreadable";
  return known ? true : undefined;
}

type BlindRole = "builder" | "test-writer";

function isBlind(role: Role): role is BlindRole {
  return role === "builder" || role === "test-writer";
}

/** The side a blind role may not see: test-side for the builder,
 *  implementation for the test-writer. */
function isOtherSide(role: BlindRole, path: string, layout: PathLayout): Tri {
  return role === "builder" ? isTestSide(path, layout) : isImplementation(path, layout);
}

/** The layout a Ctx carries; an absent field is unreadable (fail closed). */
function layoutOf(ctx: Ctx): PathLayout {
  return {
    sourceRoots: ctx.sourceRoots ?? "unreadable",
    contractGlobs: ctx.contractGlobs ?? "unreadable",
    testSuffixes: ctx.testSuffixes ?? "unreadable",
    generatedGlobs: ctx.generatedGlobs ?? "unreadable",
  };
}

function list(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

const UNREADABLE_WHY = "the project composition is unreadable, so which files are tests, implementation, contracts or generated is unknown — report it to the orchestrator";

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

// --- Writes -------------------------------------------------------------------

/**
 * Why `role` may not write the project-relative path `t`, or null when it
 * may. The one write rule: decide() and ownerOfPath() both ask it, so routing
 * can never name a role the gate would then refuse.
 */
function writeRefusal(
  role: Role,
  t: string,
  layout: PathLayout,
  protection: WriteProtection | "unreadable" | undefined,
): string | null {
  const always = alwaysWriteDenied(t, protection, layout.generatedGlobs);
  if (always !== null) return always.reason;
  const inside = inSourceRoot(t, layout.sourceRoots);
  // A name that ends with a test suffix in another case (`x.TEST.ext`) is
  // test-side to the gate, which ignores case, but not to a case-sensitive
  // file glob such as `!*.test.ext`. No role may create one, so every
  // test-side file a role wrote carries its suffix exactly as composed.
  if (layout.testSuffixes !== "unreadable" && inside !== false) {
    const suffix = testSuffixOf(t, layout.testSuffixes);
    if (suffix !== undefined && !baseName(t).endsWith(suffix)) {
      return `'${baseName(t)}' ends with the test suffix '${suffix}' in another case — ambiguous to case-sensitive tools; name it with '${suffix}' exactly`;
    }
  }
  switch (role) {
    case "reviewer":
      return `${role} has no write zone — it is read-only, and records what it found with record_design_review`;
    case "architect": {
      if (matchesAny(ZONES.architect.writeAllow, t)) return null;
      const contract = isContract(t, layout.contractGlobs);
      if (contract === true) return null;
      if (contract === undefined && inside !== false) return `whether it is a contract is unknown: ${UNREADABLE_WHY}`;
      const contracts = layout.contractGlobs === "unreadable" || layout.contractGlobs.length === 0
        ? "" : ` and contract files (${layout.contractGlobs.join(", ")})`;
      return `outside architect write zones — the architect's writable surface is ${ZONES.architect.writeAllow.join(", ")}${contracts}`;
    }
    case "builder":
    case "test-writer": {
      if (inside === undefined) return UNREADABLE_WHY;
      if (!inside) {
        const roots = layout.sourceRoots as readonly string[];
        return roots.length === 0
          ? "no composed pack declares a source root, so no role writes source — report it to the orchestrator"
          : `outside every source root — the ${role} writes ${role === "builder" ? "implementation" : "test"} files under ${roots.join(", ")}`;
      }
      if (isContract(t, layout.contractGlobs) === true) {
        return "it is a contract — the architect's; report what needs changing";
      }
      const test = isTestSide(t, layout);
      const impl = isImplementation(t, layout);
      if (role === "builder") {
        if (impl === true) return null;
        if (test === true) {
          return `it is a test file (name ends with '${testSuffixOf(t, layout.testSuffixes as readonly string[])}') — the test-writer's; you may list its name, never read or write it`;
        }
        return UNREADABLE_WHY;
      }
      if (test === true) return null;
      if (impl === true) {
        const suffixes = layout.testSuffixes as readonly string[];
        return suffixes.length === 0
          ? "no composed pack declares a test file suffix, so no file is a test — report it to the orchestrator"
          : `it is an implementation file — the builder's; the test-writer writes files named with ${list(suffixes)}`;
      }
      return UNREADABLE_WHY;
    }
  }
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
 * generated files, anything outside the project, anything the layout cannot
 * place).
 *
 * Derived from the same write rule decide() enforces, so gate routing can
 * never drift from what the path gate actually permits: a test-side file
 * routes to the test-writer, an implementation file to the builder, a
 * contract to the architect. Input is a PROJECT-RELATIVE path (type-check
 * diagnostics are relativized before they get here); absolute paths are
 * unowned rather than guessed at.
 *
 * `layout` is the project's layout (`pathLayout(cwd)` in pack-contrib.ts). A
 * bare array is the older contract-globs-only form: with no roots, suffixes
 * or generated globs known, it owns nothing but the architect's static files
 * — which, with generated files unknown, is nothing at all. Omitted, every
 * field is unreadable.
 */
export function ownerOfPath(
  path: string,
  layout: PathLayout | readonly string[] | "unreadable" = UNREADABLE_LAYOUT,
  writeProtection?: WriteProtection | "unreadable",
): Role | null {
  if (path.startsWith("/")) return null;
  const n = normalize(path, "/");
  if (!n.ok || n.path === ".") return null;
  const resolved: PathLayout = layout === "unreadable" ? UNREADABLE_LAYOUT
    : isPathLayout(layout) ? layout
    : { ...UNREADABLE_LAYOUT, contractGlobs: layout };
  return ROLES_UPSTREAM_FIRST.find((role) => writeRefusal(role, n.path, resolved, writeProtection) === null) ?? null;
}

function isPathLayout(value: PathLayout | readonly string[]): value is PathLayout {
  return !Array.isArray(value);
}

// --- Content search (ADR 2026-057) ----------------------------------------------
//
// A content search reads every file it reaches. A blind role may search a
// directory only when the search provably cannot reach the other side: the
// directory reaches no source root, or the file glob it passes provably
// excludes every other-side name. "Provably" is decided from the glob's TEXT,
// never from a guess about what it will match:
//
//   · builder, exclusion form: exactly `!*<S>`, where every composed test
//     suffix ends with S. A case-sensitive tool excludes only names ending
//     with S exactly, so this form is also checked against the file names
//     below the directory (Ctx.pathFacts): a test name in another case voids
//     it.
//   · builder, inclusion form: a glob with none of `{ } [ ] ? ! \` whose
//     literal tail T (after its last `*`, and after its last `/`) is disjoint
//     from every test suffix: T does not end with one, and is not the end of
//     one. A name that ends with T then cannot end with a test suffix,
//     whatever the case of either.
//   · test-writer, inclusion form only: the literal tail ends with a test
//     suffix or a contract suffix, so everything it reaches is test-side, a
//     contract or outside the roots.
//
// Anything else is refused, and the refusal names a glob that would pass.
//
// Whatever the glob, a directory search needs the host's account of the tree
// below it (Ctx.pathFacts): complete, and with no link in it. A link could
// lead a search into a root from outside one, or from an innocent name onto
// the other side, and whether a tool follows it is the tool's business — so
// a tree with a link is refused, as is one the host could not list.

const GLOB_SPECIAL = /[{}[\]?!\\]/;

/** Any character outside ASCII (ADR 2026-057: the filesystem may fold it). */
const NON_ASCII = /[^\x00-\x7F]/;

/** The literal ending every name matched by an inclusion glob must have. */
function literalTail(glob: string): string {
  const afterStar = glob.slice(glob.lastIndexOf("*") + 1);
  return afterStar.slice(afterStar.lastIndexOf("/") + 1).toLowerCase();
}

/** The contract suffixes behind the contract globs (`…/*<suffix>`). */
function contractSuffixes(globs: readonly string[] | "unreadable"): readonly string[] {
  if (globs === "unreadable") return [];
  return globs.map(literalTail).filter((tail) => tail.length > 0);
}

/** A composed test suffix every other one ends with, if there is one. */
function coveringSuffix(suffixes: readonly string[]): string | undefined {
  return suffixes.find((candidate) => suffixes.every((suffix) => suffix.endsWith(candidate)));
}

/** The final dotted part of a suffix (`.ext` of `.test.ext`). */
function finalPart(suffix: string): string {
  return suffix.slice(suffix.lastIndexOf("."));
}

/** The builder's inclusion-form advice: a legal glob shape, in one clause. */
function inclusionHint(suffixes: readonly string[]): string {
  const ext = finalPart(suffixes[0]!);
  return `a glob naming the files you want by their ending, such as '*.<name>${ext}' (never '*${ext}', which also matches a test name)`;
}

/** What a blind role should pass instead: one line, a legal glob in it. */
function legalGlobHint(role: BlindRole, suffixes: readonly string[]): string {
  if (role === "test-writer") {
    return `pass glob '*${suffixes[0]}' (any glob whose fixed ending ends with ${list(suffixes)}), or grep one test or contract file by path`;
  }
  const covering = coveringSuffix(suffixes);
  return covering !== undefined
    ? `pass glob '!*${covering}', or ${inclusionHint(suffixes)}, or grep one non-test file by path`
    : `pass ${inclusionHint(suffixes)}, or grep one non-test file by path — no single '!' exclusion covers all of ${list(suffixes)}`;
}

/** Null when `glob` provably keeps a search of `dir` off the other side. */
function globRefusal(
  role: BlindRole,
  glob: unknown,
  dir: string,
  layout: PathLayout,
  fileNames: readonly string[],
): string | null {
  if (layout.sourceRoots === "unreadable" || layout.testSuffixes === "unreadable") return UNREADABLE_WHY;
  const suffixes = layout.testSuffixes.map((suffix) => suffix.toLowerCase());
  if (suffixes.length === 0) {
    // No file is test-side: nothing for the builder to be kept from, and
    // nothing the test-writer's glob could name to prove itself.
    return role === "builder" ? null
      : "no composed pack declares a test file suffix, so no glob can prove it reaches no implementation — grep one contract file by path";
  }
  const hint = legalGlobHint(role, suffixes);
  const caseHint = `pass ${inclusionHint(suffixes)}, or grep one non-test file by path`;
  if (typeof glob !== "string" || glob.length === 0) {
    return `a content search of '${dir}' can reach ${role === "builder" ? "test files" : "implementation files"} — ${hint}`;
  }
  // Claude Code's Grep splits its glob on whitespace and commas into several
  // globs, so `*.handler.ts,*.test.ts` would be judged as one glob and run as
  // two. pi passes its glob to rg as one `--glob` value and splits nothing;
  // the rule is the same on both hosts, fail closed.
  if (/[\s,]/.test(glob)) {
    return `glob '${glob}' has whitespace or a comma, which a host may split into several globs — run one search per glob, each with neither — ${hint}`;
  }
  if (NON_ASCII.test(glob)) {
    return `glob '${glob}' has a non-ASCII character, which the filesystem may fold onto a different name — ${hint}`;
  }
  if (role === "builder") {
    const exclusion = /^!\*([^*{}[\]?!\\/]+)$/.exec(glob);
    if (exclusion !== null) {
      const excluded = exclusion[1]!;
      if (!suffixes.every((suffix) => suffix.endsWith(excluded))) {
        return `glob '${glob}' leaves ${list(suffixes.filter((suffix) => !suffix.endsWith(excluded)))} files searchable — ${hint}`;
      }
      const variant = fileNames.find((name) => testSuffixOf(name, suffixes) !== undefined && !name.endsWith(excluded));
      if (variant !== undefined) {
        return `glob '${glob}' is exact about case and '${variant}' under '${dir}' is a test name in another case — ${caseHint}`;
      }
      return null;
    }
  }
  if (GLOB_SPECIAL.test(glob)) {
    return `glob '${glob}' uses one of { } [ ] ? ! \\, so what it matches cannot be proven from its text — ${hint}`;
  }
  const tail = literalTail(glob);
  if (role === "builder") {
    const clash = suffixes.find((suffix) => tail.length === 0 || tail.endsWith(suffix) || suffix.endsWith(tail));
    if (clash === undefined) return null;
    return `glob '${glob}' could match a test file name ('${clash}') — ${hint}`;
  }
  const allowed = [...suffixes, ...contractSuffixes(layout.contractGlobs)];
  if (tail.length > 0 && allowed.some((suffix) => tail.endsWith(suffix))) return null;
  return `glob '${glob}' could match an implementation file — ${hint}`;
}

// --- decide() -----------------------------------------------------------------

function verb(tool: string): string {
  if (WRITE_TOOLS.has(tool)) return "write";
  if (SEARCH_TOOLS.has(tool)) return "search";
  return "read";
}

/** Why a blind role may not read `t`, or null when it may. */
function readRefusal(role: BlindRole, t: string, layout: PathLayout): string | null {
  const other = isOtherSide(role, t, layout);
  if (other === false) return null;
  if (other === undefined) return UNREADABLE_WHY;
  if (role === "builder") {
    return `it is a test file (name ends with '${testSuffixOf(t, layout.testSuffixes as readonly string[])}') — the builder may list test names but never read their content; run_tests reports failures`;
  }
  return "it is an implementation file — the test-writer may list implementation names but reads only contracts, generated files and tests";
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
// The strip (path-gate.ts) is what stops these turns being spent at all; this
// is what a refusal says on the paths the strip cannot reach.

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

/** A find pattern that names nothing outside the searched directory. */
function patternContained(pattern: unknown): boolean {
  if (pattern === undefined) return true;
  if (typeof pattern !== "string") return false;
  return !pattern.startsWith("/") && !pattern.split("/").includes("..") && !pattern.includes("\0");
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
  const layout = layoutOf(ctx);

  // A case-insensitive filesystem folds more than ASCII case: on APFS
  // `a.teſt.ts` (U+017F) IS `a.test.ts`, and `contextſ/` IS `contexts/`. The
  // sides are decided on names, so a name the gate cannot fold the way the
  // filesystem does is refused outright — for every write, and for every
  // path a blind role names.
  // A host may rewrite these before use (pi strips '@', expands '~', decodes
  // 'file://'; src/host-paths.ts). The gate applies the host's rewriting
  // first, so one still here was not rewritten — refuse rather than guess.
  if ((WRITE_TOOLS.has(tool) || isBlind(role)) && /^(?:@|~|file:)/i.test(raw)) {
    return block(`path-gate: ${role} may not ${v} '${raw}': a leading '@', '~' or 'file:' may be rewritten by the host into a path the gate did not judge — pass the plain project path`);
  }
  if ((WRITE_TOOLS.has(tool) || isBlind(role)) && NON_ASCII.test(t)) {
    return block(`path-gate: ${role} may not ${v} '${t}': it has a non-ASCII character, which the filesystem may fold onto another file's name — use the file's plain ASCII path`);
  }

  // A recursive search refuses any tree that holds `.git`; a one-level `ls`
  // shows `.git` only as a name, so it is refused only for `.git` itself or a
  // path inside it. Listing the project root is how a role learns what exists
  // without guessing.
  const gitBlocked = (): Decision | null => {
    const gitHit = SEARCH_TOOLS.has(tool) && tool !== "ls"
      ? ALWAYS_DENY.some((g) => overlaps(t, globBase(g)))
      : matchesAny(ALWAYS_DENY, t);
    return gitHit
      ? block(`path-gate: ${role} may not ${v} '${t}': '.git' is denied for all roles`)
      : null;
  };

  if (WRITE_TOOLS.has(tool)) {
    if (role === "architect" && ctx.ticketScope) {
      const scope = ctx.ticketScope;
      const otherNote = /^docs\/tn\/TN-([1-9][0-9]*)\.md$/i.exec(t);
      if (otherNote && t.toLowerCase() !== `docs/tn/tn-${scope.ticket}.md`) {
        const owner = otherNote[1]!;
        const target = { ticket: owner, frozen: scope.frozenTickets?.includes(owner) ?? false };
        const whose = scope.ticket !== undefined ? `architect may write only ticket #${scope.ticket}'s TN` : "no ticket is selected";
        return block(`path-gate: ${whose}; ${t} belongs to ticket #${owner}: ${changeRunRoute(target, scope.ticket)}`);
      }
      if (t.toLowerCase() === "spec.md") {
        return block("path-gate: ticket-numbered projects write their ticket TN, not root spec.md");
      }
      // Which files are contracts is the composed packs' contribution
      // (ADR 2026-052). When the suffixes could not be read at all, every
      // write that could be under a source root waits.
      const suffixes = scope.contractSuffixes;
      const lower = t.toLowerCase();
      const unknown = suffixes.length === 0 && scope.error !== undefined && inSourceRoot(t, layout.sourceRoots) !== false;
      if (unknown || suffixes.some((suffix) => lower.endsWith(suffix))) {
        if (scope.error) return block(`path-gate: ${scope.error}`);
        if (!scope.contracts.includes(t)) {
          const foreign = scope.foreign !== undefined && Object.hasOwn(scope.foreign, t) ? scope.foreign[t] : undefined;
          if (foreign !== undefined) return block(`path-gate: ${foreign}`);
          return block(
            `path-gate: contract '${t}' is not owned by ticket #${scope.ticket}; ` +
            `list it under \`contracts:\` in the front matter of docs/tn/TN-${scope.ticket}.md, then write it`,
          );
        }
      }
    }
    const refusal = writeRefusal(role, t, layout, ctx.writeProtection);
    if (refusal !== null) return block(`path-gate: ${role} may not write '${t}': ${refusal}`);
    return gitBlocked() ?? ALLOW;
  }

  if (!isBlind(role)) return gitBlocked() ?? ALLOW;

  if (tool === "ls" || tool === "find") {
    // Names only: a blind role may list and find the other side's file NAMES
    // (ADR 2026-057). A find pattern must stay inside the searched directory.
    if (tool === "find" && !patternContained(input["pattern"])) {
      return block(`path-gate: ${role} may not search '${t}': a find pattern must be relative and stay inside the searched directory (no leading '/', no '..')`);
    }
    return gitBlocked() ?? ALLOW;
  }

  // read, or grep: both yield content. A path the host says is a directory
  // holds no content of its own (a read of it yields at most names), so only
  // a FILE, or a path the host could not stat, is judged as a file.
  const kind = ctx.pathFacts?.kind(t);
  if (kind !== "directory") {
    const refusal = readRefusal(role, t, layout);
    if (refusal !== null) {
      return block(`path-gate: ${role} may not ${tool === "grep" ? "search" : "read"} '${t}': ${refusal}`);
    }
  }
  // A read, or a grep of one file, yields exactly that file: allowed above.
  if (tool === "read" || kind === "file") return gitBlocked() ?? ALLOW;
  const git = gitBlocked();
  if (git !== null) return git;
  if (kind === "absent") {
    return block(`path-gate: ${role} may not search '${t}': it does not exist — grep a directory or file that does`);
  }
  // A grep over a directory, or over a path the host could not stat: allowed
  // only over a fully listed tree with no link in it, and then when it reaches
  // no source root or its glob provably keeps it off the other side.
  const tree = ctx.pathFacts?.tree(t);
  if (tree === undefined) {
    return block(`path-gate: ${role} may not search '${t}': the tree below it could not be listed in full, so what a search reaches is unknown — grep a smaller directory, or one file by path`);
  }
  if (tree.oddNames.length > 0) {
    return block(`path-gate: ${role} may not search '${t}': '${tree.oddNames[0]}' has a non-ASCII name, which the filesystem may fold onto another name while a search matches it byte for byte — grep a directory without one, or one file by path`);
  }
  if (tree.links.length > 0) {
    return block(`path-gate: ${role} may not search '${t}': '${tree.links[0]}' is a link, which could lead a search anywhere — grep the directory it points into, or one file by path`);
  }
  if (reachesSourceRoot(t, layout.sourceRoots) !== false) {
    const why = globRefusal(role, input["glob"], t, layout, tree.fileNames);
    if (why !== null) return block(`path-gate: ${role} may not search '${t}': ${why}`);
  }
  return ALLOW;
}
