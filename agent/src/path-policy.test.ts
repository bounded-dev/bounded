import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { contractGlobs, writeProtection } from "./pack-contrib.ts";
import { writeProjectPacks } from "./project-composition.ts";
import {
  decide,
  FORBIDDEN_TOOLS,
  ownerOfPath,
  ROLE_TOOLS,
  ROLES_UPSTREAM_FIRST,
  ZONES,
  type Decision,
  type Role,
} from "./path-policy.js";

// TN-26-001 blindness matrix, executable form.
// Paths are resolved against a fixed project root (/repo) so tests are hermetic.

/** The contract globs of a project composing the ts pack (ADR 2026-052) —
 *  what the host resolves and hands decide(). */
function composedZone(packs: readonly string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "path-policy-zone-"));
  try {
    writeProjectPacks(dir, packs);
    return contractGlobs(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const TS_CONTRACTS = composedZone(["ts"]);

const CTX = { cwd: "/repo", contractGlobs: TS_CONTRACTS } as const;

const d = (role: Role, tool: string, path?: string): Decision =>
  decide(role, tool, path === undefined ? {} : { path }, CTX);

const A = true; // allow
const B = false; // block

const READ_TOOLS = ["read"] as const;
const SEARCH_TOOLS = ["grep", "find", "ls"] as const;
const WRITE_TOOLS = ["write", "edit"] as const;

type Row = [path: string, read: boolean, search: boolean, write: boolean];

function matrix(role: Role, rows: Row[]) {
  describe(role, () => {
    for (const [path, read, search, write] of rows) {
      test(`${role} read ${path} → ${read ? "allow" : "block"}`, () => {
        for (const tool of READ_TOOLS) {
          expect(d(role, tool, path).allow, `${tool} ${path}`).toBe(read);
        }
      });
      test(`${role} search ${path} → ${search ? "allow" : "block"}`, () => {
        for (const tool of SEARCH_TOOLS) {
          expect(d(role, tool, path).allow, `${tool} ${path}`).toBe(search);
        }
      });
      test(`${role} write ${path} → ${write ? "allow" : "block"}`, () => {
        for (const tool of WRITE_TOOLS) {
          expect(d(role, tool, path).allow, `${tool} ${path}`).toBe(write);
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// The matrix: role × tool-class × path
// ---------------------------------------------------------------------------

// The architect owns one ticket end to end: it designs, commissions the tests,
// commissions the build, and arbitrates disputes between the two blind roles.
// It therefore READS EVERYTHING and WRITES ALMOST NOTHING.
//
// Blindness is preserved exactly where it is proven load-bearing — the
// test-writer cannot see the implementation, the builder cannot see the tests —
// and the architect is no threat to it because it writes NEITHER. A role that
// cannot write a test cannot make a test agree with an implementation, which is
// the failure the separation exists to prevent. Meanwhile it must read both:
// arbitrating "this test contradicts the spec" is impossible without reading
// the test, and answering "why is this failing?" is the human's whole reason
// for talking to it.
matrix("architect", [
  // own artifacts: spec.md + colocated contracts — the ONLY writable paths
  ["spec.md", A, A, A],
  ["src/orders/orders.contract.ts", A, A, A],
  ["src/x.contract.ts", A, A, A], // ** matches zero intermediate dirs
  // builder output: readable (arbitration + diagnosis), never writable
  ["src/orders/orders.ts", A, A, B],
  ["src/orders/nested/deep.ts", A, A, B],
  ["src", A, A, B],
  ["src/orders", A, A, B],
  // tests: readable (arbitration), never writable — this is the one that stops
  // the tempting shortcut when the builder is stuck and the clock is running
  ["tests", A, A, B],
  ["tests/orders.test.ts", A, A, B],
  ["tests/sub/x.test.ts", A, A, B],
  // rest of repo: readable, not writable
  ["README.md", A, A, B],
  ["docs/guide.md", A, A, B],
  ["agent/hosts/pi/extensions/web.ts", A, A, B],
  [".gitignore", A, A, B],
  // .git denied for all roles
  [".git/config", B, B, B],
  // Root search stays blocked, but now for ONE reason only: it overlaps
  // `.git`, which is denied to everybody. With the architect's readDeny empty
  // there is no pipeline blind zone left for it to trip over, so issue #8's
  // friction (`ls src`, `ls tests`, `grep` across the tree) is gone for this
  // role — only the `.git` overlap remains, and that wants result filtering
  // rather than a widened zone.
  [".", A, B, B],
]);

matrix("test-writer", [
  // The contract is the interface under test and MUST be readable: the
  // test-writer imports from those exact paths, and dogfood Run 5 died when
  // the gate refused the read the task prompt required (it escalated, was told
  // the wall was intentional, and exited). Contracts are declaration-only —
  // the contract-purity gate enforces that — so reading one leaks no
  // implementation. Blind to src/** means blind to the IMPLEMENTATION, never
  // to the interface. Searches over src DIRECTORIES stay blocked — a listing
  // would reveal the implementation's shape — but a search scoped to one
  // contract file is allowed, since it yields no more than reading it does.
  ["spec.md", A, A, B],
  // read AND search on a specific contract file: grepping one declaration-only
  // file yields exactly what reading it yields, so denying it buys nothing
  ["src/orders/orders.contract.ts", A, A, B],
  ["src/x.contract.ts", A, A, B],
  ["src/orders/orders.ts", B, B, B],
  ["src", B, B, B],
  ["src/orders", B, B, B],
  // own zone
  ["tests", A, A, A], // globstar: tests/** includes 'tests' itself
  ["tests/orders.test.ts", A, A, A],
  ["tests/sub/x.test.ts", A, A, A],
  ["tests/fixtures/sample.json", A, A, A],
  // rest of repo: readable, not writable
  ["README.md", A, A, B],
  ["docs/guide.md", A, A, B],
  [".git/config", B, B, B],
  [".", A, B, B],
]);

matrix("builder", [
  // spec + contract: readable, never writable
  ["spec.md", A, A, B],
  ["src/orders/orders.contract.ts", A, A, B],
  ["src/x.contract.ts", A, A, B],
  // own zone
  ["src/orders/orders.ts", A, A, A],
  ["src/orders/nested/deep.ts", A, A, A],
  ["src", A, A, A], // globstar: src/** includes 'src' itself
  ["src/orders", A, A, A], // fs decides if it's a dir; policy sees src/**
  // tests: blind, forbidden
  ["tests", B, B, B],
  ["tests/orders.test.ts", B, B, B],
  ["tests/sub/x.test.ts", B, B, B],
  // rest of repo: readable, not writable
  ["README.md", A, A, B],
  ["docs/guide.md", A, A, B],
  [".git/config", B, B, B],
  [".", A, B, B],
]);

// The reviewer reads the design as the two blind consumers will, before it is
// frozen — and writes NOTHING. Not the spec it is reviewing, not a contract it
// found a defect in, not a note file in the corner of the repo. Its findings go
// into the guard log through `record_design_review` and nowhere else, because
// the spec and the contract have exactly one author and a reviewer that could
// fix what it found would be a second one.
//
// It is no threat to the blindness for the same reason the architect is not: a
// role that can write neither a test nor an implementation cannot make one
// agree with the other.
matrix("reviewer", [
  // the design under review: readable, and still not writable
  ["spec.md", A, A, B],
  ["src/orders/orders.contract.ts", A, A, B],
  ["src/x.contract.ts", A, A, B],
  // everything else the consumers can see, it can see
  ["src/orders/orders.ts", A, A, B],
  ["src", A, A, B],
  ["tests", A, A, B],
  ["tests/orders.test.ts", A, A, B],
  ["README.md", A, A, B],
  ["docs/guide.md", A, A, B],
  // no zone anywhere in the tree, however plausible the path
  ["review.md", A, A, B],
  ["src/notes.ts", A, A, B],
  [".git/config", B, B, B],
  [".", A, B, B],
]);

// ---------------------------------------------------------------------------
// Forbidden tools — backup layer under the frontmatter allowlist
// ---------------------------------------------------------------------------

describe("forbidden tools", () => {
  const roles: Role[] = ["architect", "test-writer", "builder", "reviewer"];

  // `bash` is forbidden to EVERY role including the architect. A shell defeats
  // every path rule at once, so the architect gets named tools for the things
  // it legitimately needs (the gates, git) rather than a way to run anything.
  for (const role of roles) {
    test(`${role} bash → block`, () => {
      expect(decide(role, "bash", { command: "cat tests/x.test.ts" }, CTX).allow).toBe(false);
    });
  }

  // `subagent` and `git` are the architect's, and ONLY the architect's.
  //
  // git is the sharper of the two: `git show HEAD:tests/billing.test.ts` hands
  // the builder the test source in one call, and `git log -p` does it by
  // accident. Full git in a blind role's hands defeats blindness more
  // completely than bash would.
  for (const role of ["test-writer", "builder", "reviewer"] as const) {
    test(`${role} subagent → block`, () => {
      expect(decide(role, "subagent", { agent: "scout" }, CTX).allow).toBe(false);
    });
    test(`${role} git → block (git show would reveal the other side's work)`, () => {
      expect(decide(role, "git", { args: ["show", "HEAD:tests/x.test.ts"] }, CTX).allow).toBe(
        false,
      );
    });
  }

  test("architect holds subagent — it commissions the two blind roles", () => {
    expect(decide("architect", "subagent", { agent: "builder" }, CTX).allow).toBe(true);
  });

  test("architect holds git — reflog/bisect archaeology is its job", () => {
    expect(decide("architect", "git", { args: ["reflog"] }, CTX).allow).toBe(true);
  });

  // `record_design_review` is the reviewer's, and ONLY the reviewer's. The
  // review exists because the design's author already read it once; an
  // architect recording a review of its own spec is that same reading again,
  // wearing a guard event.
  test("the reviewer holds record_design_review — it is the role's only pen", () => {
    expect(decide("reviewer", "record_design_review", { findings: [] }, CTX).allow).toBe(true);
  });

  for (const role of ["architect", "test-writer", "builder"] as const) {
    test(`${role} may not record a design review`, () => {
      const r = decide(role, "record_design_review", { findings: [] }, CTX);
      expect(r.allow).toBe(false);
      if (!r.allow) expect(r.reason).toMatch(/reviewer/);
    });
  }

  // A refusal that only says "no" costs a full model turn and teaches nothing:
  // the model retries a variant of the same call. The live architect session
  // that motivated the tool strip burned six consecutive turns on `bash` for
  // exactly this reason. So every forbidden-tool refusal must end by naming a
  // tool THIS role actually holds — checked against ROLE_TOOLS, so the advice
  // cannot drift into recommending something the gate would also refuse.
  for (const role of roles) {
    for (const tool of FORBIDDEN_TOOLS[role]) {
      test(`${role}'s '${tool}' refusal names a tool ${role} really has`, () => {
        const r = decide(role, tool, { path: "x" }, CTX);
        expect(r.allow).toBe(false);
        if (r.allow) return;
        const clause = r.reason.split("—").slice(1).join("—");
        expect(clause, `no alternative clause in: ${r.reason}`).not.toBe("");
        const named = ROLE_TOOLS[role].filter((t) => clause.includes(t));
        expect(named, `refusal points nowhere legal: ${r.reason}`).not.toHaveLength(0);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// The guard log's own directory: readable by all, writable by none
// ---------------------------------------------------------------------------

// `.bounded/` holds the guard log and the contract-checksum manifest — the audit
// trail and the drift evidence. Agents must READ them (diagnosing a jam, citing
// the log when escalating) and must never WRITE them, or the record of what
// happened becomes something the accused can edit. The gates write these files
// through plain `fs`, which never passes through the tool hook, so they are
// unaffected. Already closed by the write allowlist; this makes it explicit.
describe(".bounded is write-denied for every role, read-allowed for all", () => {
  const roles: Role[] = ["architect", "test-writer", "builder", "reviewer"];
  for (const role of roles) {
    test(`${role} may not write .bounded/guard-log.jsonl`, () => {
      expect(d(role, "write", ".bounded/guard-log.jsonl").allow).toBe(false);
      expect(d(role, "edit", ".bounded/contract-checksums.json").allow).toBe(false);
    });
  }
  test("architect may read the guard log it is expected to cite", () => {
    expect(d("architect", "read", ".bounded/guard-log.jsonl").allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tests/generated/** — machine-written, like the skeletons
// ---------------------------------------------------------------------------

// The value-object law suite is generated from the contract: it asserts what is
// true of EVERY value object (parse refuses null/[]/42/"", equality is by value,
// parsing is deterministic). Nobody hand-writes it, for the same reason nobody
// hand-writes a skeleton — an edited generated file is a lie that survives until
// the next regeneration silently discards it.
//
// The test-writer is the interesting case: `tests/**` is its write zone, so this
// is the one deny that has to be stated rather than inherited.
describe("tests/generated is write-denied for every role, test-writer included", () => {
  const roles: Role[] = ["architect", "test-writer", "builder", "reviewer"];
  for (const role of roles) {
    test(`${role} may not write under tests/generated`, () => {
      for (const tool of WRITE_TOOLS) {
        expect(d(role, tool, "tests/generated/currency.laws.test.ts").allow).toBe(false);
        expect(d(role, tool, "tests/generated/nested/deep.test.ts").allow).toBe(false);
        expect(d(role, tool, "tests/generated").allow).toBe(false);
      }
    });
  }

  test("the block says it is machine-generated and names what regenerates it", () => {
    const r = d("test-writer", "write", "tests/generated/currency.laws.test.ts");
    expect(r.allow).toBe(false);
    if (!r.allow) {
      expect(r.reason).toMatch(/machine-generated/);
      expect(r.reason).toMatch(/value-object-laws\.ts/);
    }
  });

  test("hand-written tests next to it are still the test-writer's to write", () => {
    expect(d("test-writer", "write", "tests/generatedish/x.test.ts").allow).toBe(true);
    expect(d("test-writer", "write", "tests/currency.test.ts").allow).toBe(true);
  });

  test("reads are unchanged — whoever could read tests still can", () => {
    expect(d("test-writer", "read", "tests/generated/currency.laws.test.ts").allow).toBe(true);
    expect(d("architect", "read", "tests/generated/currency.laws.test.ts").allow).toBe(true);
    // …and the builder still cannot, because it is still tests.
    expect(d("builder", "read", "tests/generated/currency.laws.test.ts").allow).toBe(false);
  });

  test("no role owns it, so a gate routes its failures to the orchestrator", () => {
    expect(ownerOfPath("tests/generated/currency.laws.test.ts")).toBe(null);
    expect(ownerOfPath("tests/currency.test.ts")).toBe("test-writer");
  });
});

// ---------------------------------------------------------------------------
// Ungated tools — this module only governs path tools
// ---------------------------------------------------------------------------

test("non-path tools are out of scope (allowlist/frontmatter owns them)", () => {
  expect(decide("builder", "typecheck", {}, CTX).allow).toBe(true);
  expect(decide("builder", "run_tests", {}, CTX).allow).toBe(true);
  expect(decide("architect", "web", { url: "https://x" }, CTX).allow).toBe(true);
});

// ---------------------------------------------------------------------------
// Hostile paths — traversal laundering, absolute paths, separators, NUL
// ---------------------------------------------------------------------------

describe("hostile paths", () => {
  test("'..' laundering into a blind zone is blocked after normalization", () => {
    expect(d("builder", "read", "src/../tests/orders.test.ts").allow).toBe(false);
    expect(d("builder", "read", "./tests/orders.test.ts").allow).toBe(false);
    expect(d("builder", "read", "tests//sub/x.test.ts").allow).toBe(false);
    // contracts are readable, but implementation laundered through '..' is not
    expect(d("test-writer", "read", "tests/../src/x.ts").allow).toBe(false);
  });

  test("'..' that escapes the project root is blocked", () => {
    expect(d("builder", "write", "../escape.ts").allow).toBe(false);
    expect(d("architect", "read", "../harness-secrets").allow).toBe(false);
    expect(d("builder", "read", "docs/../../escape").allow).toBe(false);
  });

  test("absolute paths must live under the project root", () => {
    expect(d("builder", "write", "/repo/src/x.ts").allow).toBe(true);
    expect(d("builder", "read", "/repo/tests/x.test.ts").allow).toBe(false);
    expect(d("builder", "write", "/etc/evil.ts").allow).toBe(false);
    expect(d("architect", "read", "/etc/passwd").allow).toBe(false);
  });

  test("legitimate normalization still works", () => {
    expect(d("builder", "read", "src/./x.ts").allow).toBe(true);
    expect(d("builder", "read", "tests/../src/x.ts").allow).toBe(true);
    // normalizes to src/evil.ts — genuinely inside the builder's zone
    expect(d("builder", "write", "src/x.ts/../evil.ts").allow).toBe(true);
  });

  test("backslash is a literal filename char (POSIX semantics), not traversal", () => {
    // 'tests\\x' is one segment: a file named tests\x at root. Not in any zone.
    expect(d("builder", "read", "tests\\x").allow).toBe(true);
    expect(d("builder", "write", "tests\\x").allow).toBe(false); // root file: outside write zones
  });

  test("NUL byte and empty paths are rejected", () => {
    expect(d("builder", "read", "src/x\0.ts").allow).toBe(false);
    expect(d("builder", "write", "").allow).toBe(false);
  });

  test("unscoped search tools are blocked for every role", () => {
    for (const role of ["architect", "test-writer", "builder", "reviewer"] as const) {
      for (const tool of SEARCH_TOOLS) {
        expect(d(role, tool).allow, `${role} ${tool} (no path)`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Block reasons are stable, one-line, greppable (TN: a deterministic system
// that is opaque when it jams is just a deterministic jam)
// ---------------------------------------------------------------------------

describe("block reasons", () => {
  const reason = (role: Role, tool: string, path?: string) => {
    const r = d(role, tool, path);
    if (r.allow) throw new Error(`expected block, got allow: ${role} ${tool} ${path}`);
    return r.reason;
  };

  test("exact reason strings", () => {
    expect(reason("builder", "read", "tests/orders.test.ts")).toBe(
      "path-gate: builder may not read 'tests/orders.test.ts': denied zone 'tests/**'",
    );
    expect(reason("builder", "write", "src/x.contract.ts")).toBe(
      "path-gate: builder may not write 'src/x.contract.ts': denied for builder (matches 'src/**/*.contract.ts') — that path is another role's; report what needs changing",
    );
    expect(reason("reviewer", "write", "spec.md")).toBe(
      "path-gate: reviewer may not write 'spec.md': reviewer has no write zone — it is read-only, and records what it found with record_design_review",
    );
    expect(reason("architect", "write", "src/orders/orders.ts")).toBe(
      "path-gate: architect may not write 'src/orders/orders.ts': outside architect write zones — the architect's writable surface is spec.md, docs/tn/TN-*.md, CONTEXT.md, ADRs/*.md, scratch/**, src/**/*.contract.ts",
    );
    expect(reason("test-writer", "grep")).toBe(
      "path-gate: test-writer may not use unscoped 'grep': pass an explicit path inside your zones",
    );
    expect(reason("builder", "bash", "ignored")).toBe(
      "path-gate: builder may not use 'bash': no role holds a shell — use read/grep/find/ls, run_tests, or typecheck",
    );
    expect(reason("architect", "bash", "ignored")).toBe(
      "path-gate: architect may not use 'bash': no role holds a shell — use the git tool, the gate tools, or typecheck",
    );
    expect(reason("architect", "run_tests")).toBe(
      "path-gate: architect may not use 'run_tests': run_tests is the builder's blind-safe channel — run red_gate/green_gate instead, which run the suite and typecheck together",
    );
    expect(reason("architect", "record_design_review")).toBe(
      "path-gate: architect may not use 'record_design_review': record_design_review is the reviewer's pen — commission the reviewer with subagent instead; a review you record of your own design is not a second reading of it",
    );
    expect(reason("builder", "git")).toBe(
      "path-gate: builder may not use 'git': 'git' is the architect's — use read/grep/find/ls, run_tests, or typecheck",
    );
    expect(reason("builder", "write", "../escape.ts")).toBe(
      "path-gate: builder may not write '../escape.ts': path escapes project root",
    );
    expect(reason("architect", "read", "/etc/passwd")).toBe(
      "path-gate: architect may not read '/etc/passwd': absolute path outside project root (/repo)",
    );
    expect(reason("builder", "read", ".git/config")).toBe(
      "path-gate: builder may not read '.git/config': '.git' is denied for all roles",
    );
    expect(reason("builder", "ls", ".")).toBe(
      "path-gate: builder may not search '.': overlaps denied zone 'tests'",
    );
  });
});

// --- ownerOfPath --------------------------------------------------------------
// "Who may fix this file?" — derived from the same write zones as decide(), so
// gate routing can never disagree with what the path gate actually permits.

describe("ownerOfPath", () => {
  const cases: [path: string, owner: Role | null][] = [
    ["spec.md", "architect"],
    ["src/orders/orders.contract.ts", "architect"],
    ["src/orders.contract.ts", "architect"],
    ["tests/orders.test.ts", "test-writer"],
    ["tests/fakes/clock.ts", "test-writer"],
    ["src/orders/orders.ts", "builder"],
    ["src/shared/errors.ts", "builder"],
    // Project config is generated from the composed packs and no role may
    // write it (ADR 2026-054): a config diagnostic routes to the orchestrator.
    ["vitest.config.ts", null],
    ["package.json", null],
    ["package-lock.json", null],
    ["tsconfig.json", null],
    // The architect's scratch zone is the architect's alone — so a typecheck
    // diagnostic in a probe routes to the architect, never to a blind role.
    ["scratch/probe.ts", "architect"],
    ["scratch/deep/nested/probe.ts", "architect"],
    // Genuinely outside every zone: nobody in the pipeline may fix it.
    ["docs/notes.md", null],
  ];
  for (const [path, owner] of cases) {
    test(`${path} → ${owner ?? "(unowned)"}`, () => {
      expect(ownerOfPath(path, TS_CONTRACTS)).toBe(owner);
    });
  }

  test("normalizes before matching (leading ./ and redundant segments)", () => {
    expect(ownerOfPath("./tests/orders.test.ts")).toBe("test-writer");
    expect(ownerOfPath("src/orders/../orders/orders.ts")).toBe("builder");
  });

  test("paths escaping the project root are unowned, never mis-routed", () => {
    expect(ownerOfPath("../elsewhere/src/x.ts")).toBe(null);
  });

  test("every owned path agrees with decide(): its owner may write it", () => {
    for (const [path, owner] of cases) {
      if (owner === null) continue;
      expect(decide(owner, "write", { path }, CTX).allow, `${owner} write ${path}`).toBe(true);
    }
  });

  // A gate that routed a failure to the reviewer would deadlock the loop: the
  // named role must be one that can actually make the fix, and this one holds
  // no pen. It stays in the list only so a role that LATER gains a zone cannot
  // be silently unroutable.
  test("nothing routes to the reviewer, which could not act on it", () => {
    for (const [path] of cases) expect(ownerOfPath(path)).not.toBe("reviewer");
    expect(ZONES.reviewer.writeAllow).toEqual([]);
  });

  test("the routing order covers every role the policy knows", () => {
    expect([...ROLES_UPSTREAM_FIRST].sort()).toEqual(Object.keys(ZONES).sort());
  });
});

// ---------------------------------------------------------------------------
// Case: the filesystem is case-insensitive, so the gate must be too
// ---------------------------------------------------------------------------

// Two findings, one cause. The friendly one (dogfood Run 6): the architect
// tried to write `SPEC.md`, was refused because the zone glob is the literal
// `spec.md`, and lost turns to a rule that reads as arbitrary — on macOS those
// are the SAME FILE.
//
// The serious one: the same case-sensitivity applies to the DENY side. On a
// case-insensitive filesystem `TESTS/orders.test.ts` IS the tests directory,
// but a case-sensitive `tests/**` pattern does not match it — so a case-varied
// path would walk straight through the blindness the whole pipeline rests on.
describe("zone matching is case-insensitive", () => {
  test("the architect may write its spec whatever the case", () => {
    for (const p of ["spec.md", "SPEC.md", "Spec.md"]) {
      expect(d("architect", "write", p).allow, `write ${p}`).toBe(true);
    }
  });

  test("a case-varied tests path does not escape the builder's blindness", () => {
    for (const p of ["tests/orders.test.ts", "TESTS/orders.test.ts", "Tests/Orders.Test.ts"]) {
      expect(d("builder", "read", p).allow, `read ${p}`).toBe(false);
    }
  });

  test("a case-varied src path does not escape the test-writer's blindness", () => {
    for (const p of ["src/money.ts", "SRC/money.ts", "Src/Money.ts"]) {
      expect(d("test-writer", "read", p).allow, `read ${p}`).toBe(false);
    }
  });

  test("a case-varied contract path is still denied to the builder's pen", () => {
    for (const p of ["src/money.contract.ts", "src/money.CONTRACT.ts"]) {
      expect(d("builder", "write", p).allow, `write ${p}`).toBe(false);
    }
  });

  test("'.git' is denied whatever the case", () => {
    for (const p of [".git/config", ".GIT/config", ".Git/config"]) {
      expect(d("architect", "read", p).allow, `read ${p}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Reading the harness's own skill files
// ---------------------------------------------------------------------------

// Every run so far has opened with the architect trying to read
// `~/.pi/agent/skills/developer-stage/SKILL.md` and being refused — five
// attempts across four runs, for two different skills. That block was never a
// deliberate policy: it falls out of the generic "absolute path outside the
// project root" containment rule.
//
// Skill files are the agent's own instructions. They contain nothing about the
// run, so reading one leaks neither the tests nor the implementation, and the
// agent asking for them is behaving reasonably.
//
// But the harness root is NOT safe to open wholesale: `auth.json` holds
// credentials and `sessions/` holds transcripts of every other session on the
// machine. So allow the instruction content specifically, read-only.
const HARNESS = "/Users/x/.pi/agent";
const H = (role: Role, tool: string, path: string): Decision =>
  decide(role, tool, { path }, { cwd: "/repo", harnessRoot: HARNESS });

describe("harness skill files are readable, the rest of the harness is not", () => {
  const roles: Role[] = ["architect", "test-writer", "builder"];

  for (const role of roles) {
    test(`${role} may read a top-level skill`, () => {
      expect(H(role, "read", `${HARNESS}/skills/developer-stage/SKILL.md`).allow).toBe(true);
    });
    test(`${role} may read a pack skill`, () => {
      expect(
        H(role, "read", `${HARNESS}/packs/ts/skills/ts-contract-authoring/SKILL.md`).allow,
      ).toBe(true);
    });
    test(`${role} may read a skill's reference files`, () => {
      expect(H(role, "read", `${HARNESS}/skills/issue-tracking/references/setup.md`).allow).toBe(
        true,
      );
    });
    // Run 29: the skills point every role at a pack's reference component to
    // copy its shape; that read must be allowed, or the pointer sends the role
    // to a blocked path.
    test(`${role} may read a pack reference component`, () => {
      expect(H(role, "read", `${HARNESS}/packs/ts/reference/README.md`).allow).toBe(true);
      expect(
        H(role, "read", `${HARNESS}/packs/ts/reference/src/readings/reading-id.contract.ts`).allow,
      ).toBe(true);
    });
    test(`${role} may NOT write a pack reference file`, () => {
      expect(H(role, "write", `${HARNESS}/packs/ts/reference/src/readings/reading-id.ts`).allow).toBe(
        false,
      );
    });

    // The part that must stay shut.
    test(`${role} may NOT read harness credentials`, () => {
      expect(H(role, "read", `${HARNESS}/auth.json`).allow).toBe(false);
    });
    test(`${role} may NOT read other sessions' transcripts`, () => {
      expect(H(role, "read", `${HARNESS}/sessions/whatever.jsonl`).allow).toBe(false);
    });
    test(`${role} may NOT read the harness's own source`, () => {
      expect(H(role, "read", `${HARNESS}/src/path-policy.ts`).allow).toBe(false);
    });
    test(`${role} may NOT write a skill file`, () => {
      expect(H(role, "write", `${HARNESS}/skills/developer-stage/SKILL.md`).allow).toBe(false);
      expect(H(role, "edit", `${HARNESS}/skills/developer-stage/SKILL.md`).allow).toBe(false);
    });
    // A path that merely mentions the harness must not be a way out.
    test(`${role} may NOT traverse out of a skills path`, () => {
      expect(H(role, "read", `${HARNESS}/skills/../auth.json`).allow).toBe(false);
      expect(H(role, "read", `${HARNESS}/skills/x/../../auth.json`).allow).toBe(false);
    });
  }

  test("with no harnessRoot configured, nothing outside the project opens up", () => {
    expect(d("architect", "read", `${HARNESS}/skills/developer-stage/SKILL.md`).allow).toBe(false);
  });
});

// Run 7 found the other half of the same block. The architect read
// `packs/ts/skills/ts-contract-authoring/SKILL.md` from an absolute path
// happily, then asked for pi-subagents' SKILL.md — the documentation for the
// `subagent` tool it drives the whole pipeline with — and was refused, because
// an INSTALLED pack lives under `npm/node_modules/`, not `packs/`. Same kind of
// file, same read-only need, opposite answer.
//
// The cost was visible: it could not look up `runs.run`, the gate semantics or
// resume, and spent two turns guessing out loud instead.
//
// node_modules is a code tree, so this arm is narrower than the harness's own
// `skills/**`: prose only (`.md`), and only under a `skills/` directory. A
// dependency's source stays as shut as the harness's own source.
describe("skills shipped by installed packs and extensions are readable too", () => {
  const PI_SUBAGENTS = `${HARNESS}/npm/node_modules/pi-subagents/skills/pi-subagents/SKILL.md`;

  for (const role of ["architect", "test-writer", "builder"] as const) {
    test(`${role} may read an installed pack's skill`, () => {
      expect(H(role, "read", PI_SUBAGENTS).allow).toBe(true);
    });
  }

  test("a scoped package's skill works the same way", () => {
    expect(
      H("architect", "read", `${HARNESS}/npm/node_modules/@acme/pack/skills/thing/SKILL.md`).allow,
    ).toBe(true);
  });

  test("a skill's reference prose comes with it", () => {
    expect(
      H("architect", "read", `${HARNESS}/npm/node_modules/pi-subagents/skills/pi-subagents/references/gates.md`)
        .allow,
    ).toBe(true);
  });

  test("an extension's skill is readable on the same terms", () => {
    expect(H("architect", "read", `${HARNESS}/extensions/dev-stage/skills/x/SKILL.md`).allow).toBe(
      true,
    );
  });

  // The rest of the dependency tree stays shut.
  test("a non-skill file under the same node_modules tree is still refused", () => {
    expect(H("architect", "read", `${HARNESS}/npm/node_modules/pi-subagents/dist/index.js`).allow).toBe(
      false,
    );
    expect(H("architect", "read", `${HARNESS}/npm/node_modules/pi-subagents/package.json`).allow).toBe(
      false,
    );
    // Code inside a skills/ directory is code, not instructions.
    expect(
      H("architect", "read", `${HARNESS}/npm/node_modules/pi-subagents/skills/pi-subagents/run.js`)
        .allow,
    ).toBe(false);
    expect(H("architect", "read", `${HARNESS}/npm/node_modules/.bin/pi`).allow).toBe(false);
  });

  test("unrelated absolute paths are still refused", () => {
    expect(H("architect", "read", "/etc/passwd").allow).toBe(false);
    expect(H("architect", "read", "/Users/x/other-project/README.md").allow).toBe(false);
    expect(H("architect", "read", "/Users/x/.pi/agent-other/skills/x/SKILL.md").allow).toBe(false);
    expect(H("architect", "read", `${HARNESS}/auth.json`).allow).toBe(false);
  });

  test("still read-only, and still no way to climb out", () => {
    expect(H("architect", "write", PI_SUBAGENTS).allow).toBe(false);
    expect(H("architect", "edit", PI_SUBAGENTS).allow).toBe(false);
    expect(
      H("architect", "read", `${HARNESS}/npm/node_modules/p/skills/../../../../auth.json`).allow,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run_tests is the builder's channel, and only the builder's
// ---------------------------------------------------------------------------

// Run 6's architect called `run_tests` once. Harmless in that instance — it was
// diagnosing a blocked red gate — but it revealed a drift: ROLE_TOOLS.architect
// does not list run_tests, yet nothing enforced that, because run_tests is not
// a PATH tool and the gate only inspected path tools.
//
// The declared allowlist binds subagents through their frontmatter. A session
// launched from `.bounded/dev-stage-role` has no frontmatter, so the allowlist is
// documentation there and the gate is the only enforcement. It should agree
// with what ROLE_TOOLS says.
//
// run_tests exists as the blind-safe debugging channel for the one role that
// implements against a suite it cannot read. The architect can read the tests
// and has red_gate and green_gate; the test-writer has neither need nor
// business running the implementation.
describe("run_tests is builder-only", () => {
  test("the builder may run it — it is the whole point of the tool", () => {
    expect(decide("builder", "run_tests", {}, CTX).allow).toBe(true);
  });

  for (const role of ["architect", "test-writer", "reviewer"] as const) {
    test(`${role} may not run it`, () => {
      const d = decide(role, "run_tests", {}, CTX);
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toMatch(/red_gate|green_gate|builder/);
    });
  }

  test("every role keeps typecheck — each must confirm its own work compiles", () => {
    for (const role of ["architect", "test-writer", "builder", "reviewer"] as const) {
      expect(decide(role, "typecheck", {}, CTX).allow).toBe(true);
    }
  });
});

// `remove` is write-class: Run 8's test-writer could not delete its own broken
// test file, and the architect fell back to `git clean -f` in someone else's
// zone. Deleting must obey exactly the write zones.

describe("remove obeys write zones", () => {
  const ctx = { cwd: "/proj", contractGlobs: TS_CONTRACTS };

  test("test-writer may remove its own test file", () => {
    expect(decide("test-writer", "remove", { path: "tests/values-boundaries.test.ts" }, ctx).allow).toBe(true);
  });

  test("test-writer may not remove implementation or generated laws", () => {
    expect(decide("test-writer", "remove", { path: "src/money.ts" }, ctx).allow).toBe(false);
    expect(decide("test-writer", "remove", { path: "tests/generated/money.laws.test.ts" }, ctx).allow).toBe(false);
  });

  test("builder may remove inside src but never a contract", () => {
    expect(decide("builder", "remove", { path: "src/shared/errors.ts" }, ctx).allow).toBe(true);
    expect(decide("builder", "remove", { path: "src/money.contract.ts" }, ctx).allow).toBe(false);
    expect(decide("builder", "remove", { path: "tests/money.test.ts" }, ctx).allow).toBe(false);
  });

  test("architect may remove only what it may write", () => {
    expect(decide("architect", "remove", { path: "src/orders/orders.contract.ts" }, ctx).allow).toBe(true);
    expect(decide("architect", "remove", { path: "tests/money.test.ts" }, ctx).allow).toBe(false);
  });

  test("the reviewer may remove nothing at all — it has no write zone", () => {
    for (const path of ["spec.md", "src/money.contract.ts", "tests/money.test.ts", "notes.md"]) {
      expect(decide("reviewer", "remove", { path }, ctx).allow, `remove ${path}`).toBe(false);
    }
  });
});

// ADR 2026-054: project config is generated from the composed packs. Run 9
// once gave the architect config writes for the "orchestrator" route; the
// test-runner config is code the gates execute, so no role may write any of it.

describe("no role may write project config", () => {
  const ctx = { cwd: "/proj", contractGlobs: TS_CONTRACTS };
  const CONFIG = [
    "tsconfig.json", "tsconfig.api.json", "package.json", "package-lock.json",
    "vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vite.config.ts", ".npmrc",
  ];
  test("every role is refused every write-class tool on a config file", () => {
    for (const path of CONFIG) {
      for (const role of ["architect", "test-writer", "builder", "reviewer"] as const) {
        for (const tool of ["write", "edit", "remove"] as const) {
          expect(decide(role, tool, { path }, ctx).allow, `${role} ${tool} ${path}`).toBe(false);
        }
      }
    }
  });
  test("project knowledge stays the architect's alone", () => {
    for (const path of ["CONTEXT.md", "ADRs/2026-001-domain.md"]) {
      expect(decide("architect", "write", { path }, ctx).allow, path).toBe(true);
      for (const role of ["test-writer", "builder", "reviewer"] as const) {
        expect(decide(role, "write", { path }, ctx).allow, `${role}: ${path}`).toBe(false);
      }
    }
  });
});

// Nested dependency directories, harness state and config (ADR 2026-054). The
// stack's tools resolve the nearest node_modules, package.json or tsconfig
// before the root's, so one inside a role's zone would let that role replace a
// dependency or re-configure a gate. The directory and file names are the ts
// pack's data; .git and .bounded are the core's.
describe("nested dependency dirs, harness state and config are write-denied at any depth", () => {
  const protection = (() => {
    const dir = mkdtempSync(join(tmpdir(), "path-policy-protect-"));
    try {
      writeProjectPacks(dir, ["ts"]);
      return writeProtection(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  const ctx = { cwd: "/proj", contractGlobs: TS_CONTRACTS, writeProtection: protection };
  const refused = (role: Role, path: string): void => {
    for (const tool of ["write", "edit", "remove"] as const) {
      expect(decide(role, tool, { path }, ctx).allow, `${role} ${tool} ${path}`).toBe(false);
    }
  };

  test("the pack names its dependency directory and nested config names", () => {
    expect(protection.dirNames).toEqual(["node_modules"]);
    expect(protection.fileNames).toContain("package.json");
  });

  test("the builder may not plant a dependency or config inside src/", () => {
    for (const path of [
      "src/node_modules/zod/package.json",
      "src/node_modules/zod/index.d.ts",
      "src/deep/NODE_MODULES/x.js",
      "src/.bounded/package.json",
      "src/.bounded/tsconfig.json",
      "src/.GIT/config",
      "src/ui/package.json",
      "src/ui/tsconfig.app.json",
      "src/JSCONFIG.json",
    ]) refused("builder", path);
    expect(decide("builder", "write", { path: "src/node_modules" }, ctx).allow).toBe(false);
    expect(decide("builder", "write", { path: "src/money/money.ts" }, ctx).allow).toBe(true);
    expect(decide("builder", "write", { path: "src/money/package-info.ts" }, ctx).allow).toBe(true);
  });

  test("the test-writer may not either, inside tests/", () => {
    for (const path of ["tests/node_modules/x/index.js", "tests/.bounded/x", "tests/.git/HEAD", "tests/unit/tsconfig.json"]) {
      refused("test-writer", path);
    }
    expect(decide("test-writer", "write", { path: "tests/unit/money.test.ts" }, ctx).allow).toBe(true);
  });

  test("the architect may not inside its scratch zone", () => {
    for (const path of ["scratch/node_modules/x.js", "scratch/package.json", "scratch/.git/config"]) refused("architect", path);
    expect(decide("architect", "write", { path: "scratch/probe.ts" }, ctx).allow).toBe(true);
  });

  test("the core names survive without any pack; an unreadable composition refuses every write", () => {
    expect(decide("builder", "write", { path: "src/.bounded/x" }, { cwd: "/proj" }).allow).toBe(false);
    expect(decide("builder", "write", { path: "src/.GIT/x" }, { cwd: "/proj" }).allow).toBe(false);
    const unreadable = { cwd: "/proj", writeProtection: "unreadable" as const };
    expect(decide("test-writer", "write", { path: "tests/x.test.ts" }, unreadable).allow).toBe(false);
    expect(decide("test-writer", "read", { path: "tests/x.test.ts" }, unreadable).allow).toBe(true);
  });

  test("a protected path has no owner, so routing never names a role the gate refuses", () => {
    expect(ownerOfPath("src/node_modules/zod/index.d.ts", TS_CONTRACTS, protection)).toBeNull();
    expect(ownerOfPath("src/.bounded/x.ts", TS_CONTRACTS)).toBeNull();
    expect(ownerOfPath("src/money/money.ts", TS_CONTRACTS, protection)).toBe("builder");
  });
});

// The architect's sanctioned scratch zone (Fix 4). Three runs, three models each
// tried to write a throwaway type-probe and were refused, then one smuggled it
// in as a real contract. The zone is top-level so it overlaps no artifact zone,
// architect-only so the three blind roles cannot write it.
describe("the architect scratch zone", () => {
  const ctx = { cwd: "/proj", contractGlobs: TS_CONTRACTS };

  test("the architect may write, edit and remove inside scratch/", () => {
    for (const tool of ["write", "edit", "remove"] as const) {
      expect(decide("architect", tool, { path: "scratch/probe.ts" }, ctx).allow, tool).toBe(true);
    }
    expect(decide("architect", "write", { path: "scratch/deep/nested/probe.ts" }, ctx).allow).toBe(true);
  });

  test("the three blind roles may NOT write scratch/ — it is the architect's alone", () => {
    for (const role of ["test-writer", "builder", "reviewer"] as const) {
      const r = decide(role, "write", { path: "scratch/probe.ts" }, ctx);
      expect(r.allow, role).toBe(false);
    }
  });

  test("no role's write zone but the architect's includes scratch/", () => {
    expect(ZONES.architect.writeAllow).toContain("scratch/**");
    for (const role of ["test-writer", "builder", "reviewer"] as const) {
      expect(ZONES[role].writeAllow).not.toContain("scratch/**");
    }
  });
});

// ADR 2026-052: contract files enter the architect's zone only through the
// composed packs' contract globs. The core lists none of them.
describe("pack-contributed architect contract zone", () => {
  test("the ts pack contributes exactly its contract glob", () => {
    expect(TS_CONTRACTS).toEqual(["src/**/*.contract.ts"]);
  });

  test("without composed contract globs the architect gets no contract write", () => {
    for (const ctx of [{ cwd: "/proj" }, { cwd: "/proj", contractGlobs: "unreadable" as const }]) {
      expect(decide("architect", "write", { path: "src/a.contract.ts" }, ctx).allow).toBe(false);
      expect(decide("architect", "write", { path: "spec.md" }, ctx).allow).toBe(true);
    }
    expect(ownerOfPath("src/a.contract.ts")).not.toBe("architect");
    expect(ownerOfPath("src/a.contract.ts", "unreadable")).not.toBe("architect");
    for (const glob of TS_CONTRACTS) expect(ZONES.architect.writeAllow).not.toContain(glob);
  });

  test("another pack's suffix is what the architect may write", () => {
    const ctx = { cwd: "/proj", contractGlobs: ["src/**/*.iface.py"] };
    expect(decide("architect", "write", { path: "src/a.iface.py" }, ctx).allow).toBe(true);
    expect(decide("architect", "write", { path: "src/a.contract.ts" }, ctx).allow).toBe(false);
  });
});

// ADR 2026-052: the test-writer's contract read exception and the builder's
// contract write deny are the composed contract globs too, never a core name.
describe("pack-contributed contract globs for the blind roles", () => {
  test("the core zones name no contract file", () => {
    expect(ZONES["test-writer"].readExcept).toEqual([]);
    expect(ZONES.builder.writeDeny).toEqual([]);
  });

  test("another pack's suffix is what the blind roles see and cannot write", () => {
    const ctx = { cwd: "/proj", contractGlobs: ["src/**/*.iface.py"] };
    expect(decide("test-writer", "read", { path: "src/a/b.iface.py" }, ctx).allow).toBe(true);
    expect(decide("test-writer", "read", { path: "src/a/b.contract.ts" }, ctx).allow).toBe(false);
    expect(decide("builder", "write", { path: "src/a/b.iface.py" }, ctx).allow).toBe(false);
    expect(decide("builder", "write", { path: "src/a/b.contract.ts" }, ctx).allow).toBe(true);
  });

  test("with no contract globs, nothing in src/ is readable to the test-writer", () => {
    expect(decide("test-writer", "read", { path: "src/a.contract.ts" }, { cwd: "/proj" }).allow).toBe(false);
  });

  test("an unreadable composition closes src/ to the builder and opens nothing to the test-writer", () => {
    const ctx = { cwd: "/proj", contractGlobs: "unreadable" as const };
    const w = decide("builder", "write", { path: "src/money.ts" }, ctx);
    expect(w.allow).toBe(false);
    expect(decide("builder", "write", { path: "scratch/x.ts" }, ctx).allow).toBe(false);
    expect(decide("test-writer", "read", { path: "src/a.contract.ts" }, ctx).allow).toBe(false);
    expect(decide("test-writer", "write", { path: "tests/a.test.ts" }, ctx).allow).toBe(true);
  });
});
