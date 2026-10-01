import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writeProtection } from "./pack-contrib.ts";
import { writeProjectPacks } from "./project-composition.ts";
import {
  decide,
  FORBIDDEN_TOOLS,
  ownerOfPath,
  ROLE_TOOLS,
  ROLES_UPSTREAM_FIRST,
  UNREADABLE_LAYOUT,
  ZONES,
  type Ctx,
  type Decision,
  type PathFacts,
  type PathLayout,
  type Role,
} from "./path-policy.js";

// TN-26-001 blindness matrix, executable form, on the layout of ADRs
// 2026-056…058: source roots, suffix-based test side, generated files.
// Paths resolve against a fixed project root (/repo) so tests are hermetic.
// The layout below is the hexagonal monorepo's (TN-26-012), handed in the way a
// host hands in what the composed packs contribute; the core names none of it.

const ROOTS = ["apps/*/src", "contexts/*/src"];
const SUFFIXES = [".test.ts", ".test.tsx", ".test-support.ts"];
const CONTRACT_GLOBS = ["apps/*/src/**/*.contract.ts", "contexts/*/src/**/*.contract.ts"];
const GENERATED = [
  "**/*.laws.test.ts",
  "architecture.test.ts",
  "docs/architecture/**",
  "contexts/*/src/domain/index.ts",
  "contexts/*/src/application/*/*/*.command.ts",
  "contexts/*/src/adapters/in/trpc/**",
  "contexts/*/src/adapters/out/drizzle/drizzle-test-database.test-support.ts",
];
const LAYOUT: PathLayout = {
  sourceRoots: ROOTS,
  contractGlobs: CONTRACT_GLOBS,
  testSuffixes: SUFFIXES,
  generatedGlobs: GENERATED,
};

const ROOT = "contexts/pm/src";
const FEATURE = `${ROOT}/application/notes/create-note`;
const P = {
  test: `${FEATURE}/create-note.test.ts`,
  handler: `${FEATURE}/create-note.handler.ts`,
  contract: `${FEATURE}/create-note.contract.ts`,
  command: `${FEATURE}/create-note.command.ts`,
  commandLaws: `${FEATURE}/create-note.command.laws.test.ts`,
  support: `${FEATURE}/create-note.store.test-support.ts`,
  laws: `${ROOT}/domain/notes/note-text.laws.test.ts`,
  concept: `${ROOT}/domain/notes/note-text.ts`,
  domainIndex: `${ROOT}/domain/index.ts`,
  trpc: `${ROOT}/adapters/in/trpc/notes/create-note.procedure.ts`,
  storeTest: `${ROOT}/adapters/out/drizzle/notes/create-note.store.test.ts`,
  generatedSupport: `${ROOT}/adapters/out/drizzle/drizzle-test-database.test-support.ts`,
  webTest: "apps/web/src/client/app.test.tsx",
  webRoot: "apps/web/src/server/composition-root.ts",
};

/** A fake filesystem: these files (and links) exist, and every ancestor is a
 *  directory. */
function factsFor(files: readonly string[], links: readonly string[] = []): PathFacts {
  const dirs = new Set<string>(["."]);
  for (const file of [...files, ...links]) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const below = (dir: string, paths: readonly string[]) =>
    paths.filter((path) => dir === "." || path.startsWith(`${dir}/`));
  return {
    kind: (path) => (dirs.has(path) ? "directory" : files.includes(path) || links.includes(path) ? "file" : "absent"),
    tree: (dir) => ({
      fileNames: below(dir, files).map((file) => file.slice(file.lastIndexOf("/") + 1)),
      links: below(dir, links),
      oddNames: below(dir, [...files, ...links]).filter((path) => /[^\x00-\x7F]/.test(path)),
    }),
  };
}
const FILES = [
  ...Object.values(P), "docs/guide.md", "docs/example.test.ts", "spec.md", "docs/architecture/testing.md",
  "contexts-archive/notes.md", "contexts/new/src/x/y.handler.ts",
];
const FACTS = factsFor(FILES);

const CTX: Ctx = { cwd: "/repo", ...LAYOUT, pathFacts: FACTS };

const d = (role: Role, tool: string, path?: string, extra: Record<string, unknown> = {}, ctx: Ctx = CTX): Decision =>
  decide(role, tool, path === undefined ? { ...extra } : { path, ...extra }, ctx);

const reasonOf = (decision: Decision): string => {
  if (decision.allow) throw new Error("expected a refusal, got allow");
  return decision.reason;
};

const A = true; // allow
const B = false; // block

type Row = [path: string, read: boolean, list: boolean, grep: boolean, write: boolean];

function matrix(role: Role, rows: Row[]) {
  describe(role, () => {
    for (const [path, read, list, grep, write] of rows) {
      test(`${role} read ${path} → ${read ? "allow" : "block"}`, () => {
        expect(d(role, "read", path).allow).toBe(read);
      });
      test(`${role} ls/find ${path} → ${list ? "allow" : "block"}`, () => {
        // A one-level ls of the project root shows `.git` only as a name, so
        // it is allowed where a recursive find of the root is not (#35).
        expect(d(role, "ls", path).allow, `ls ${path}`).toBe(list || path === ".");
        expect(d(role, "find", path, { pattern: "*" }).allow, `find ${path}`).toBe(list);
      });
      test(`${role} grep (no glob) ${path} → ${grep ? "allow" : "block"}`, () => {
        expect(d(role, "grep", path, { pattern: "x" }).allow).toBe(grep);
      });
      test(`${role} write ${path} → ${write ? "allow" : "block"}`, () => {
        for (const tool of ["write", "edit", "remove"]) {
          expect(d(role, tool, path).allow, `${tool} ${path}`).toBe(write);
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// The matrix: role × tool class × path
// ---------------------------------------------------------------------------

// The architect owns one ticket end to end, so it READS EVERYTHING and WRITES
// ALMOST NOTHING: its own design (spec, TN, contracts) and its scratch zone.
// It is no threat to the blindness because it writes neither a test nor an
// implementation.
matrix("architect", [
  ["spec.md", A, A, A, A],
  [P.contract, A, A, A, A],
  [P.handler, A, A, A, B],
  [P.test, A, A, A, B],
  [P.command, A, A, A, B],
  [P.laws, A, A, A, B],
  [ROOT, A, A, A, B],
  ["contexts", A, A, A, B],
  ["docs/guide.md", A, A, A, B],
  [".git/config", B, B, B, B],
  // Root search stays blocked for ONE reason only: it overlaps `.git`.
  [".", A, B, B, B],
]);

// The test-writer: writes test-side files in the roots, reads contracts,
// generated files, tests and everything outside the roots, and may LIST
// implementation names — never read or search their content.
matrix("test-writer", [
  ["spec.md", A, A, A, B],
  [P.contract, A, A, A, B],
  [P.command, A, A, A, B], // generated: readable to all, written by none
  [P.domainIndex, A, A, A, B],
  [P.trpc, A, A, A, B],
  [P.laws, A, A, A, B],
  [P.commandLaws, A, A, A, B],
  [P.generatedSupport, A, A, A, B],
  [P.test, A, A, A, A],
  [P.support, A, A, A, A],
  [P.storeTest, A, A, A, A],
  [P.webTest, A, A, A, A],
  [P.handler, B, A, B, B],
  [P.concept, B, A, B, B],
  [P.webRoot, B, A, B, B],
  // Directories: a name listing is fine; a content search needs a glob.
  [ROOT, A, A, B, B],
  [FEATURE, A, A, B, B],
  ["contexts", A, A, B, B],
  ["docs/guide.md", A, A, A, B],
  ["docs", A, A, A, B],
  [".git/config", B, B, B, B],
  [".", A, B, B, B],
]);

// The builder: writes implementation files in the roots, reads everything but
// test-side files, and may LIST test names — never read or search them.
matrix("builder", [
  ["spec.md", A, A, A, B],
  [P.contract, A, A, A, B],
  [P.command, A, A, A, B],
  [P.domainIndex, A, A, A, B],
  [P.trpc, A, A, A, B],
  // Generated laws are shared: blindness guards authored work only.
  [P.laws, A, A, A, B],
  [P.commandLaws, A, A, A, B],
  [P.generatedSupport, A, A, A, B],
  [P.handler, A, A, A, A],
  [P.concept, A, A, A, A],
  [P.webRoot, A, A, A, A],
  [P.test, B, A, B, B],
  [P.support, B, A, B, B],
  [P.storeTest, B, A, B, B],
  [P.webTest, B, A, B, B],
  [ROOT, A, A, B, B],
  // A directory inside a root is judged as the path it is; the filesystem
  // decides whether a write to it can happen at all.
  [FEATURE, A, A, B, A],
  ["contexts", A, A, B, B],
  ["apps", A, A, B, B],
  ["docs/guide.md", A, A, A, B],
  ["docs", A, A, A, B],
  // Outside every root: a file named like a test is nobody's test.
  ["docs/example.test.ts", A, A, A, B],
  [".git/config", B, B, B, B],
  [".", A, B, B, B],
]);

// The reviewer reads the design as the two blind consumers will, and writes
// NOTHING: not the spec, not a contract, not a note in a corner of the repo.
matrix("reviewer", [
  ["spec.md", A, A, A, B],
  [P.contract, A, A, A, B],
  [P.handler, A, A, A, B],
  [P.test, A, A, A, B],
  [ROOT, A, A, A, B],
  ["review.md", A, A, A, B],
  [".git/config", B, B, B, B],
  [".", A, B, B, B],
]);

// ---------------------------------------------------------------------------
// The WI-2 acceptance cases, named
// ---------------------------------------------------------------------------

describe("acceptance: suffix blindness in the hexagonal layout", () => {
  test("builder ls/find over a context's source root is allowed", () => {
    expect(d("builder", "ls", "contexts/pm/src").allow).toBe(true);
    expect(d("builder", "find", "contexts/pm/src", { pattern: "**/*.test.ts" }).allow).toBe(true);
  });

  test("builder read of a colocated test is refused", () => {
    expect(d("builder", "read", "contexts/pm/src/application/notes/create-note/create-note.test.ts").allow).toBe(false);
  });

  test("builder grep: no glob refused, provable exclusion or disjoint tail allowed, '*.ts' refused", () => {
    // With only `.test.ts` composed, one exclusion covers every test file.
    const single: Ctx = { ...CTX, testSuffixes: [".test.ts"] };
    const grep = (glob: string | undefined, ctx: Ctx = CTX) =>
      d("builder", "grep", "contexts/pm/src", glob === undefined ? { pattern: "x" } : { pattern: "x", glob }, ctx).allow;
    expect(grep(undefined)).toBe(false);
    expect(grep("!*.test.ts", single)).toBe(true);
    expect(grep("*.handler.ts")).toBe(true);
    expect(grep("*.ts")).toBe(false);
  });

  test("with three test suffixes, '!*.test.ts' is refused: it leaves the others searchable", () => {
    const r = d("builder", "grep", "contexts/pm/src", { pattern: "x", glob: "!*.test.ts" });
    expect(reasonOf(r)).toContain("'.test.tsx', '.test-support.ts' files searchable");
  });

  test("test-writer: implementation refused, contract allowed, generated command allowed", () => {
    expect(d("test-writer", "read", P.handler).allow).toBe(false);
    expect(d("test-writer", "read", P.contract).allow).toBe(true);
    expect(d("test-writer", "read", P.command).allow).toBe(true);
  });

  test("a generated law suite is written by no role", () => {
    for (const role of ["architect", "test-writer", "builder", "reviewer"] as const) {
      for (const path of [P.laws, P.commandLaws]) {
        expect(d(role, "write", path).allow, `${role} ${path}`).toBe(false);
      }
    }
  });

  test("ownerOfPath routes x.test.ts to the test-writer and x.ts to the builder", () => {
    expect(ownerOfPath(P.test, LAYOUT)).toBe("test-writer");
    expect(ownerOfPath(P.handler, LAYOUT)).toBe("builder");
  });

  test("case does not open a door: X.TEST.TS is a test", () => {
    const upper = `${FEATURE}/CREATE-NOTE.TEST.TS`;
    expect(d("builder", "read", upper).allow).toBe(false);
    expect(d("builder", "write", upper).allow).toBe(false);
    expect(ownerOfPath(upper, LAYOUT)).not.toBe("builder");
  });
});

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
// Content search: the glob must PROVE the other side is out of reach
// ---------------------------------------------------------------------------

describe("builder grep over a directory: the glob is judged on its text", () => {
  const grep = (glob: unknown, ctx: Ctx = CTX, path = ROOT) =>
    decide("builder", "grep", { path, pattern: "x", ...(glob === undefined ? {} : { glob }) }, ctx);

  test.each([
    "*.handler.ts", "*.store.ts", "*.contract.ts", "*.command.ts", "**/*.handler.ts",
    "application/**/*.handler.ts", "*.mapper.ts", "*.tsx.snap", "*/index.ts", "index.ts",
    "*.Handler.ts",
  ])("inclusion glob %s has a tail no test name can end with → allowed", (glob) => {
    expect(grep(glob).allow).toBe(true);
  });

  test.each([
    ["*.ts", "'.ts' ends '.test.ts'"],
    ["*.tsx", "ends '.test.tsx'"],
    ["*", "empty tail"],
    ["**", "empty tail"],
    ["**/*", "empty tail"],
    ["*.test.ts", "is a test suffix"],
    ["*.store.test.ts", "ends with a test suffix"],
    ["*.test-support.ts", "is a test suffix"],
    ["*.TEST.TS", "a test suffix in another case"],
    ["*.Ts", "case of a clashing tail"],
    ["*st.ts", "the end of '.test.ts'"],
    ["application/", "empty basename tail"],
    ["*.{handler,test}.ts", "braces"],
    ["*.[a-z]s", "a class"],
    ["*.handler.t?", "a '?'"],
    ["*.handler.ts\\", "an escape"],
    ["!*.handler.ts", "an exclusion that leaves tests in"],
    ["!*.ts", "an exclusion covering more than one suffix is not the accepted form"],
    ["!**/*.test.ts", "an exclusion with a path"],
    ["", "an empty glob"],
  ])("glob %j is refused (%s)", (glob) => {
    expect(grep(glob).allow).toBe(false);
  });

  test("a non-string glob is refused, never ignored", () => {
    expect(grep(["*.handler.ts"]).allow).toBe(false);
    expect(grep(42).allow).toBe(false);
  });

  test("the exclusion form is accepted exactly when one suffix covers every test suffix", () => {
    const covering: Ctx = { ...CTX, testSuffixes: [".test.ts", ".laws.test.ts"] };
    expect(grep("!*.test.ts", covering).allow).toBe(true);
    expect(grep("!*.laws.test.ts", covering).allow).toBe(false);
    expect(grep("!*.TEST.TS", covering).allow).toBe(false);
  });

  test("the exclusion form is case-exact, so a test name in another case voids it", () => {
    const single: Ctx = { ...CTX, testSuffixes: [".test.ts"] };
    const variant: Ctx = { ...single, pathFacts: factsFor([...FILES, `${FEATURE}/other.Test.ts`]) };
    expect(grep("!*.test.ts", single).allow).toBe(true);
    const r = grep("!*.test.ts", variant);
    expect(reasonOf(r)).toContain("'other.Test.ts'");
    expect(reasonOf(r)).toContain("'*.<name>.ts'");
  });

  test("any directory search needs the full tree below: without it, or with a link in it, it is refused", () => {
    const { pathFacts: _, ...noFacts } = CTX;
    expect(grep("*.handler.ts", noFacts).allow).toBe(false);
    const unlisted: Ctx = { ...CTX, pathFacts: { kind: FACTS.kind, tree: () => undefined } };
    expect(reasonOf(grep("*.handler.ts", unlisted))).toContain("could not be listed in full");
    expect(grep("*.handler.ts", unlisted, "docs").allow).toBe(false);
    const linked: Ctx = { ...CTX, pathFacts: factsFor(FILES, [`${FEATURE}/innocent.handler.ts`, "docs/into-root"]) };
    expect(reasonOf(grep("*.handler.ts", linked))).toContain(`'${FEATURE}/innocent.handler.ts' is a link`);
    expect(reasonOf(grep(undefined, linked, "docs"))).toContain("'docs/into-root' is a link");
    // A single file is judged as a read: its tree is irrelevant.
    expect(grep(undefined, linked, P.handler).allow).toBe(true);
  });

  test("a path that does not exist is not searched", () => {
    expect(reasonOf(grep("*.handler.ts", CTX, `${FEATURE}/missing`))).toContain("does not exist");
  });

  test("a directory that reaches no source root needs no glob", () => {
    expect(grep(undefined, CTX, "docs").allow).toBe(true);
    expect(grep(undefined, CTX, "contexts-archive").allow).toBe(true);
  });

  test("a directory above a root, a root, and anything under one need the proof", () => {
    for (const path of [".", "contexts", "contexts/pm", "apps", "apps/web", ROOT, FEATURE, "contexts/new/src/x"]) {
      expect(grep(undefined, CTX, path).allow, path).toBe(false);
      if (path !== ".") expect(grep("*.handler.ts", CTX, path).allow, path).toBe(true);
    }
  });

  test("with no test suffix composed, no file is test-side and any grep is allowed", () => {
    expect(grep(undefined, { ...CTX, testSuffixes: [] }).allow).toBe(true);
  });

  test("a single-file grep is judged as a read of that file, whatever the glob", () => {
    expect(grep(undefined, CTX, P.handler).allow).toBe(true);
    expect(grep("*.handler.ts", CTX, P.test).allow).toBe(false);
    expect(grep("!*.test.ts", CTX, P.support).allow).toBe(false);
  });

  test("a path the host cannot stat is judged both as a file and as a directory", () => {
    const { pathFacts: _, ...noFacts } = CTX;
    expect(grep("*.handler.ts", noFacts, P.test).allow).toBe(false); // could be the test file itself
    expect(grep(undefined, noFacts, P.handler).allow).toBe(false); // could be a directory
  });

  test("a directory NAMED like a test is judged by its content, not its name", () => {
    const dir = `${FEATURE}/fixtures.test.ts`;
    const ctx: Ctx = { ...CTX, pathFacts: factsFor([...FILES, `${dir}/inner.test.ts`]) };
    expect(grep(undefined, ctx, dir).allow).toBe(false);
    expect(grep("*.handler.ts", ctx, dir).allow).toBe(true);
  });
});

describe("test-writer grep over a directory: only a glob that reaches tests or contracts", () => {
  const grep = (glob: unknown, ctx: Ctx = CTX, path = ROOT) =>
    decide("test-writer", "grep", { path, pattern: "x", ...(glob === undefined ? {} : { glob }) }, ctx);

  test.each(["*.test.ts", "**/*.test.ts", "*.store.test.ts", "*.test.tsx", "*.test-support.ts", "*.contract.ts", "*.laws.test.ts"])(
    "%s reaches only test files or contracts → allowed", (glob) => {
      expect(grep(glob).allow).toBe(true);
    },
  );

  test.each([undefined, "*.ts", "*", "*.handler.ts", "!*.handler.ts", "!*.ts", "*.{test,spec}.ts", "*.test.t?", "*test.ts"])(
    "%j could reach an implementation file → refused", (glob) => {
      expect(grep(glob).allow).toBe(false);
    },
  );

  test("outside every root it may search freely; inside, a single contract or test file is fine", () => {
    expect(grep(undefined, CTX, "docs").allow).toBe(true);
    expect(grep(undefined, CTX, P.contract).allow).toBe(true);
    expect(grep(undefined, CTX, P.test).allow).toBe(true);
    expect(grep(undefined, CTX, P.command).allow).toBe(true);
    expect(grep("*.test.ts", CTX, P.handler).allow).toBe(false);
  });

  test("with no test suffix composed nothing proves a directory search", () => {
    expect(grep("*.test.ts", { ...CTX, testSuffixes: [] }).allow).toBe(false);
    expect(grep("*.contract.ts", { ...CTX, testSuffixes: [] }).allow).toBe(false);
  });
});

describe("refusals name the legal alternative", () => {
  test("builder, three suffixes: an inclusion glob shape and the single-file route", () => {
    expect(reasonOf(d("builder", "grep", ROOT, { pattern: "x" }))).toBe(
      "path-gate: builder may not search 'contexts/pm/src': a content search of 'contexts/pm/src' can reach test files — " +
        "pass a glob naming the files you want by their ending, such as '*.<name>.ts' (never '*.ts', which also matches a test name), " +
        "or grep one non-test file by path — no single '!' exclusion covers all of '.test.ts', '.test.tsx', '.test-support.ts'",
    );
  });

  test("builder, one covering suffix: the exact exclusion glob to pass", () => {
    const r = d("builder", "grep", ROOT, { pattern: "x", glob: "*.ts" }, { ...CTX, testSuffixes: [".test.ts"] });
    expect(reasonOf(r)).toBe(
      "path-gate: builder may not search 'contexts/pm/src': glob '*.ts' could match a test file name ('.test.ts') — " +
        "pass glob '!*.test.ts', or a glob naming the files you want by their ending, such as '*.<name>.ts' (never '*.ts', which also matches a test name), or grep one non-test file by path",
    );
  });

  test("builder, a glob with special characters says why it cannot be proven", () => {
    expect(reasonOf(d("builder", "grep", ROOT, { pattern: "x", glob: "*.[ab].ts" }))).toContain("cannot be proven from its text");
  });

  test("test-writer: the exact inclusion glob to pass", () => {
    expect(reasonOf(d("test-writer", "grep", ROOT, { pattern: "x" }))).toBe(
      "path-gate: test-writer may not search 'contexts/pm/src': a content search of 'contexts/pm/src' can reach implementation files — " +
        "pass glob '*.test.ts' (any glob whose fixed ending ends with '.test.ts', '.test.tsx', '.test-support.ts'), or grep one test or contract file by path",
    );
  });

  test("reads of the other side say what the role may do instead", () => {
    expect(reasonOf(d("builder", "read", P.test))).toBe(
      `path-gate: builder may not read '${P.test}': it is a test file (name ends with '.test.ts') — the builder may list test names but never read their content; run_tests reports failures`,
    );
    expect(reasonOf(d("test-writer", "read", P.handler))).toBe(
      `path-gate: test-writer may not read '${P.handler}': it is an implementation file — the test-writer may list implementation names but reads only contracts, generated files and tests`,
    );
    expect(reasonOf(d("builder", "grep", P.test, { pattern: "x" }))).toMatch(/^path-gate: builder may not search .*it is a test file/);
  });

  test("writes say whose file it is and what the role writes", () => {
    expect(reasonOf(d("builder", "write", P.test))).toContain("the test-writer's; you may list its name, never read or write it");
    expect(reasonOf(d("builder", "write", P.contract))).toContain("it is a contract — the architect's");
    expect(reasonOf(d("builder", "write", "docs/x.ts"))).toContain("outside every source root — the builder writes implementation files under apps/*/src, contexts/*/src");
    expect(reasonOf(d("test-writer", "write", P.handler))).toContain("the test-writer writes files named with '.test.ts', '.test.tsx', '.test-support.ts'");
    expect(reasonOf(d("test-writer", "write", P.laws))).toContain("it is a generated file (matches '**/*.laws.test.ts', ADR 2026-058)");
    expect(reasonOf(d("reviewer", "write", "spec.md"))).toBe(
      "path-gate: reviewer may not write 'spec.md': reviewer has no write zone — it is read-only, and records what it found with record_design_review",
    );
    expect(reasonOf(d("architect", "write", P.handler))).toBe(
      `path-gate: architect may not write '${P.handler}': outside architect write zones — the architect's writable surface is spec.md, docs/tn/TN-*.md, CONTEXT.md, ADRs/*.md, scratch/** and contract files (apps/*/src/**/*.contract.ts, contexts/*/src/**/*.contract.ts)`,
    );
  });

  test("stable reasons for the general refusals", () => {
    expect(reasonOf(d("test-writer", "grep"))).toBe(
      "path-gate: test-writer may not use unscoped 'grep': pass an explicit path inside your zones",
    );
    expect(reasonOf(d("builder", "write", "../escape.ts"))).toBe(
      "path-gate: builder may not write '../escape.ts': path escapes project root",
    );
    expect(reasonOf(d("architect", "read", "/etc/passwd"))).toBe(
      "path-gate: architect may not read '/etc/passwd': absolute path outside project root (/repo)",
    );
    expect(reasonOf(d("builder", "read", ".git/config"))).toBe(
      "path-gate: builder may not read '.git/config': '.git' is denied for all roles",
    );
    expect(reasonOf(d("builder", "find", ".", { pattern: "*" }))).toBe(
      "path-gate: builder may not search '.': '.git' is denied for all roles",
    );
    expect(reasonOf(d("builder", "ls", ".git"))).toBe(
      "path-gate: builder may not search '.git': '.git' is denied for all roles",
    );
    expect(reasonOf(d("builder", "bash", "ignored"))).toBe(
      "path-gate: builder may not use 'bash': no role holds a shell — use read/grep/find/ls, run_tests, or typecheck",
    );
  });
});

describe("find patterns stay inside the searched directory", () => {
  test.each(["../**/*.test.ts", "/etc/*", "a/../../b"])("a blind role's find pattern %j is refused", (pattern) => {
    expect(d("builder", "find", ROOT, { pattern }).allow).toBe(false);
    expect(d("test-writer", "find", ROOT, { pattern }).allow).toBe(false);
  });
  test("a non-string pattern is refused", () => {
    expect(d("builder", "find", ROOT, { pattern: 3 }).allow).toBe(false);
  });
  test("names of the other side are fine to find", () => {
    expect(d("builder", "find", ROOT, { pattern: "**/*.test.ts" }).allow).toBe(true);
    expect(d("test-writer", "find", ROOT, { pattern: "**/*.handler.ts" }).allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generated files (ADR 2026-058): shared, written by nobody
// ---------------------------------------------------------------------------

describe("generated files are write-denied for every role and readable by all", () => {
  const roles: Role[] = ["architect", "test-writer", "builder", "reviewer"];
  const generated = [P.command, P.commandLaws, P.laws, P.domainIndex, P.trpc, P.generatedSupport, "architecture.test.ts", "docs/architecture/testing.md"];

  for (const role of roles) {
    test(`${role} may read every generated file and write none`, () => {
      for (const path of generated) {
        expect(d(role, "read", path).allow, `read ${path}`).toBe(true);
        for (const tool of ["write", "edit", "remove"]) expect(d(role, tool, path).allow, `${tool} ${path}`).toBe(false);
      }
    });
  }

  test("the refusal says it is generated and which glob matched", () => {
    expect(reasonOf(d("builder", "write", P.command))).toBe(
      `path-gate: builder may not write '${P.command}': it is a generated file (matches 'contexts/*/src/application/*/*/*.command.ts', ADR 2026-058) — a generator writes it from the design and a hand edit is discarded; read it freely, and report what should change to the orchestrator`,
    );
  });

  test("generated beats test-side: a generated test file is nobody's, and the builder reads it", () => {
    expect(ownerOfPath(P.laws, LAYOUT)).toBeNull();
    expect(ownerOfPath(P.generatedSupport, LAYOUT)).toBeNull();
    expect(d("builder", "read", P.generatedSupport).allow).toBe(true);
  });

  test("the core names no generated file: without the socket nothing is generated", () => {
    const none: Ctx = { ...CTX, generatedGlobs: [] };
    expect(d("test-writer", "write", P.laws, {}, none).allow).toBe(true);
    expect(d("builder", "write", P.command, {}, none).allow).toBe(true);
  });

  test("an unreadable generated socket refuses every write, and opens no read", () => {
    const unreadable: Ctx = { ...CTX, generatedGlobs: "unreadable" };
    for (const role of roles) {
      for (const path of ["spec.md", "scratch/x.ts", P.handler, P.test, P.contract]) {
        expect(d(role, "write", path, {}, unreadable).allow, `${role} ${path}`).toBe(false);
      }
    }
    // A generated test-named file is then possibly a test: closed to the builder.
    expect(d("builder", "read", P.laws, {}, unreadable).allow).toBe(false);
    // …and a generated implementation-named file possibly implementation: closed to the test-writer.
    expect(d("test-writer", "read", P.command, {}, unreadable).allow).toBe(false);
    // Plain implementation and tests are unaffected on the side that can see them.
    expect(d("builder", "read", P.handler, {}, unreadable).allow).toBe(true);
    expect(d("test-writer", "read", P.test, {}, unreadable).allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fail closed: every unreadable socket closes what it decides
// ---------------------------------------------------------------------------

describe("unreadable layout data fails closed", () => {
  test("unreadable source roots: every path that could lie in a root is the other side", () => {
    const ctx: Ctx = { ...CTX, sourceRoots: "unreadable" };
    // Any test-named file anywhere could be a test; any other file could be
    // implementation. Only a name that decides the question on its own opens.
    expect(d("builder", "read", P.test, {}, ctx).allow).toBe(false);
    expect(d("builder", "read", "docs/example.test.ts", {}, ctx).allow).toBe(false);
    expect(d("builder", "read", P.handler, {}, ctx).allow).toBe(true);
    expect(d("test-writer", "read", P.handler, {}, ctx).allow).toBe(false);
    expect(d("test-writer", "read", "docs/guide.md", {}, ctx).allow).toBe(false);
    expect(d("test-writer", "read", P.test, {}, ctx).allow).toBe(true);
    expect(d("test-writer", "read", P.contract, {}, ctx).allow).toBe(true);
    for (const role of ["builder", "test-writer"] as const) {
      for (const path of [P.handler, P.test, "docs/guide.md", "anything/x.ts"]) {
        expect(d(role, "write", path, {}, ctx).allow, `${role} write ${path}`).toBe(false);
      }
      // A top-level file can never be inside a root; `.bounded` can never be one.
      expect(d(role, "read", "spec.md", {}, ctx).allow).toBe(true);
      expect(d(role, "read", ".bounded/guard-log.jsonl", {}, ctx).allow).toBe(true);
      // Names are still fine; content search is not.
      expect(d(role, "ls", "contexts", {}, ctx).allow).toBe(true);
      expect(d(role, "grep", "docs", { pattern: "x", glob: "*.test.ts" }, ctx).allow).toBe(false);
    }
    expect(reasonOf(d("builder", "read", P.test, {}, ctx))).toContain("the project composition is unreadable");
    expect(reasonOf(d("builder", "write", P.handler, {}, ctx))).toContain("the project composition is unreadable");
  });

  test("unreadable test suffixes: every file under a root is the other side", () => {
    const ctx: Ctx = { ...CTX, testSuffixes: "unreadable" };
    for (const path of [P.handler, P.test]) {
      expect(d("builder", "read", path, {}, ctx).allow, `builder ${path}`).toBe(false);
      expect(d("test-writer", "read", path, {}, ctx).allow, `test-writer ${path}`).toBe(false);
      expect(d("builder", "write", path, {}, ctx).allow).toBe(false);
      expect(d("test-writer", "write", path, {}, ctx).allow).toBe(false);
    }
    // A contract is never implementation, so the test-writer keeps it; the
    // builder cannot rule out that it is test-side without the suffixes.
    expect(d("test-writer", "read", P.contract, {}, ctx).allow).toBe(true);
    expect(d("builder", "read", P.contract, {}, ctx).allow).toBe(false);
    // Outside the roots nothing changes.
    expect(d("builder", "read", "docs/guide.md", {}, ctx).allow).toBe(true);
    expect(d("builder", "grep", ROOT, { pattern: "x", glob: "*.handler.ts" }, ctx).allow).toBe(false);
  });

  test("unreadable contract globs: no contract is known, so the builder writes nothing in a root", () => {
    const ctx: Ctx = { ...CTX, contractGlobs: "unreadable" };
    expect(d("builder", "write", P.handler, {}, ctx).allow).toBe(false);
    expect(d("architect", "write", P.contract, {}, ctx).allow).toBe(false);
    expect(d("architect", "write", "spec.md", {}, ctx).allow).toBe(true);
    // The test-writer can no longer tell a contract from implementation.
    expect(d("test-writer", "read", P.contract, {}, ctx).allow).toBe(false);
    expect(d("test-writer", "read", P.handler, {}, ctx).allow).toBe(false);
    expect(d("test-writer", "write", P.test, {}, ctx).allow).toBe(true);
    // The builder reads what it could before: contracts were never hidden from it.
    expect(d("builder", "read", P.contract, {}, ctx).allow).toBe(true);
  });

  test("a Ctx without layout fields is unreadable, never empty", () => {
    const bare: Ctx = { cwd: "/repo" };
    expect(d("builder", "read", P.test, {}, bare).allow).toBe(false);
    expect(d("test-writer", "read", P.handler, {}, bare).allow).toBe(false);
    expect(d("builder", "write", P.handler, {}, bare).allow).toBe(false);
    expect(d("test-writer", "write", P.test, {}, bare).allow).toBe(false);
    // Roles that read everything are unaffected.
    expect(d("architect", "read", P.test, {}, bare).allow).toBe(true);
    expect(d("reviewer", "read", P.handler, {}, bare).allow).toBe(true);
  });

  test("no source root composed: no role writes source, and nothing is test-side", () => {
    const none: Ctx = { ...CTX, sourceRoots: [], contractGlobs: [] };
    expect(reasonOf(d("builder", "write", P.handler, {}, none))).toContain("no composed pack declares a source root");
    expect(d("test-writer", "write", P.test, {}, none).allow).toBe(false);
    expect(d("architect", "write", P.contract, {}, none).allow).toBe(false);
    expect(d("builder", "read", P.test, {}, none).allow).toBe(true);
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
  test("'..' laundering onto the other side is blocked after normalization", () => {
    expect(d("builder", "read", `${ROOT}/domain/../application/notes/create-note/create-note.test.ts`).allow).toBe(false);
    expect(d("builder", "read", `./${P.test}`).allow).toBe(false);
    expect(d("builder", "read", P.test.replace("/create-note/", "//create-note/")).allow).toBe(false);
    expect(d("test-writer", "read", `${FEATURE}/x.test.ts/../create-note.handler.ts`).allow).toBe(false);
    expect(d("test-writer", "read", `docs/../${P.handler}`).allow).toBe(false);
  });

  test("'..' out of a root does not carry the root's permission along", () => {
    expect(d("builder", "write", `${ROOT}/../package-notes.ts`).allow).toBe(false);
    expect(d("builder", "write", `${ROOT}/../../other/src/x.ts`).allow).toBe(true); // lands in contexts/other/src
    expect(d("test-writer", "write", `${ROOT}/../x.test.ts`).allow).toBe(false);
  });

  test("'..' that escapes the project root is blocked", () => {
    expect(d("builder", "write", "../escape.ts").allow).toBe(false);
    expect(d("architect", "read", "../harness-secrets").allow).toBe(false);
    expect(d("builder", "read", "docs/../../escape").allow).toBe(false);
  });

  test("absolute paths are judged as the project path they name", () => {
    expect(d("builder", "write", `/repo/${P.handler}`).allow).toBe(true);
    expect(d("builder", "read", `/repo/${P.test}`).allow).toBe(false);
    expect(d("test-writer", "read", `/repo/${P.handler}`).allow).toBe(false);
    expect(d("test-writer", "write", `/repo/${P.test}`).allow).toBe(true);
    expect(d("builder", "write", "/etc/evil.ts").allow).toBe(false);
    expect(d("builder", "read", "/repository/x.ts").allow).toBe(false);
    expect(d("architect", "read", "/etc/passwd").allow).toBe(false);
  });

  test("backslash is a literal filename char (POSIX semantics), not traversal", () => {
    const name = `${FEATURE}\\x.test.ts`; // one segment below application/notes
    expect(d("builder", "read", name).allow).toBe(false); // still ends with .test.ts
    expect(d("builder", "read", "docs\\x").allow).toBe(true);
    expect(d("builder", "write", "docs\\x").allow).toBe(false);
  });

  test("NUL byte and empty paths are rejected", () => {
    expect(d("builder", "read", `${P.handler}\0`).allow).toBe(false);
    expect(d("builder", "write", "").allow).toBe(false);
  });

  test("unscoped search tools are blocked for every role", () => {
    for (const role of ["architect", "test-writer", "builder", "reviewer"] as const) {
      for (const tool of ["grep", "find", "ls"]) {
        expect(d(role, tool).allow, `${role} ${tool} (no path)`).toBe(false);
      }
    }
  });

  test("a root directory itself is not inside the root", () => {
    expect(d("builder", "write", ROOT).allow).toBe(false);
    expect(d("test-writer", "write", ROOT).allow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case: the filesystem is case-insensitive, so the gate must be too
// ---------------------------------------------------------------------------

describe("side matching is case-insensitive", () => {
  test("a case-varied test suffix is still a test to the builder", () => {
    for (const name of ["x.TEST.TS", "x.Test.ts", "x.test.TSX", "x.TEST-SUPPORT.ts"]) {
      expect(d("builder", "read", `${FEATURE}/${name}`).allow, name).toBe(false);
    }
  });

  test("a case-varied root is still the root", () => {
    for (const path of ["CONTEXTS/pm/SRC/a.test.ts", "Contexts/Pm/Src/application/x.test.ts", "APPS/web/SRC/x.test.tsx"]) {
      expect(d("builder", "read", path).allow, path).toBe(false);
    }
    for (const path of ["CONTEXTS/pm/SRC/a.handler.ts", "Apps/Web/Src/main.ts"]) {
      expect(d("test-writer", "read", path).allow, path).toBe(false);
      expect(d("builder", "write", path).allow, path).toBe(true);
    }
  });

  test("a case-varied contract is still a contract", () => {
    for (const name of ["money.CONTRACT.ts", "Money.Contract.TS"]) {
      expect(d("builder", "write", `${ROOT}/domain/${name}`).allow, name).toBe(false);
      expect(d("test-writer", "read", `${ROOT}/domain/${name}`).allow, name).toBe(true);
    }
  });

  test("a case-varied generated file is still generated", () => {
    expect(d("test-writer", "write", `${ROOT}/domain/notes/x.LAWS.test.ts`).allow).toBe(false);
    expect(d("builder", "read", `${ROOT}/domain/notes/x.Laws.Test.ts`).allow).toBe(true);
  });

  test("no role may create a test name whose suffix is in another case", () => {
    for (const role of ["test-writer", "builder", "architect"] as const) {
      const r = d(role, "write", `${FEATURE}/x.Test.ts`);
      expect(r.allow, role).toBe(false);
    }
    expect(reasonOf(d("test-writer", "write", `${FEATURE}/x.Test.ts`))).toContain("name it with '.test.ts' exactly");
    expect(ownerOfPath(`${FEATURE}/x.Test.ts`, LAYOUT)).toBeNull();
  });

  test("the architect may write its spec whatever the case; '.git' is denied whatever the case", () => {
    for (const p of ["spec.md", "SPEC.md", "Spec.md"]) expect(d("architect", "write", p).allow, p).toBe(true);
    for (const p of [".git/config", ".GIT/config", ".Git/config"]) expect(d("architect", "read", p).allow, p).toBe(false);
  });
});

// --- ownerOfPath --------------------------------------------------------------
// "Who may fix this file?" — the same write rule as decide(), so gate routing
// can never disagree with what the path gate actually permits.

describe("ownerOfPath", () => {
  const cases: [path: string, owner: Role | null][] = [
    ["spec.md", "architect"],
    [P.contract, "architect"],
    [P.test, "test-writer"],
    [P.support, "test-writer"],
    [P.storeTest, "test-writer"],
    [P.webTest, "test-writer"],
    [P.handler, "builder"],
    [P.concept, "builder"],
    [P.webRoot, "builder"],
    // Generated: no role may write it, so a failure routes to the orchestrator.
    [P.command, null],
    [P.laws, null],
    [P.commandLaws, null],
    [P.trpc, null],
    ["architecture.test.ts", null],
    // Project config and anything outside every root and zone: unowned.
    ["package.json", null],
    ["tsconfig.json", null],
    ["docs/notes.md", null],
    ["contexts/pm/package.json", null],
    // The architect's scratch zone is the architect's alone.
    ["scratch/probe.ts", "architect"],
  ];
  for (const [path, owner] of cases) {
    test(`${path} → ${owner ?? "(unowned)"}`, () => {
      expect(ownerOfPath(path, LAYOUT)).toBe(owner);
    });
  }

  test("normalizes before matching (leading ./ and redundant segments)", () => {
    expect(ownerOfPath(`./${P.test}`, LAYOUT)).toBe("test-writer");
    expect(ownerOfPath(`${FEATURE}/../create-note/create-note.handler.ts`, LAYOUT)).toBe("builder");
  });

  test("paths escaping the project root, and absolute paths, are unowned", () => {
    expect(ownerOfPath("../elsewhere/contexts/pm/src/x.ts", LAYOUT)).toBe(null);
    expect(ownerOfPath(`/repo/${P.handler}`, LAYOUT)).toBe(null);
  });

  test("every owned path agrees with decide(): its owner may write it, no other role may", () => {
    for (const [path, owner] of cases) {
      for (const role of ["architect", "test-writer", "builder", "reviewer"] as const) {
        expect(decide(role, "write", { path }, CTX).allow, `${role} write ${path}`).toBe(role === owner);
      }
    }
  });

  test("a protected name has no owner", () => {
    const protection = { dirNames: ["node_modules"], fileNames: ["package.json"] };
    expect(ownerOfPath(`${ROOT}/node_modules/x/index.ts`, LAYOUT, protection)).toBeNull();
    expect(ownerOfPath(`${ROOT}/sub/package.json`, LAYOUT, protection)).toBeNull();
    expect(ownerOfPath(P.handler, LAYOUT, protection)).toBe("builder");
    expect(ownerOfPath(P.handler, LAYOUT, "unreadable")).toBeNull();
  });

  test("an unreadable layout, or the old contract-globs-only form, owns nothing", () => {
    for (const layout of [UNREADABLE_LAYOUT, "unreadable" as const, CONTRACT_GLOBS]) {
      for (const [path] of cases) expect(ownerOfPath(path, layout), path).toBeNull();
    }
    expect(ownerOfPath(P.handler)).toBeNull();
  });

  test("nothing routes to the reviewer, which could not act on it", () => {
    for (const [path] of cases) expect(ownerOfPath(path, LAYOUT)).not.toBe("reviewer");
    expect(ZONES.reviewer.writeAllow).toEqual([]);
  });

  test("the routing order covers every role the policy knows", () => {
    expect([...ROLES_UPSTREAM_FIRST].sort()).toEqual(Object.keys(ZONES).sort());
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

// ---------------------------------------------------------------------------
// The guard log's own directory: readable by all, writable by none
// ---------------------------------------------------------------------------

describe(".bounded is write-denied for every role, read-allowed for all", () => {
  for (const role of ["architect", "test-writer", "builder", "reviewer"] as const) {
    test(`${role} may not write .bounded, and may read the guard log`, () => {
      expect(d(role, "write", ".bounded/guard-log.jsonl").allow).toBe(false);
      expect(d(role, "edit", ".bounded/contract-checksums.json").allow).toBe(false);
      expect(d(role, "read", ".bounded/guard-log.jsonl").allow).toBe(true);
    });
  }
});

// `remove` is write-class: Run 8's test-writer could not delete its own broken
// test file, and the architect fell back to `git clean -f` in someone else's
// zone. Deleting must obey exactly the write zones.
describe("remove obeys write zones", () => {
  test("test-writer may remove its own test file, never implementation or generated laws", () => {
    expect(d("test-writer", "remove", P.test).allow).toBe(true);
    expect(d("test-writer", "remove", P.handler).allow).toBe(false);
    expect(d("test-writer", "remove", P.laws).allow).toBe(false);
  });

  test("builder may remove implementation, never a contract or a test", () => {
    expect(d("builder", "remove", P.concept).allow).toBe(true);
    expect(d("builder", "remove", P.contract).allow).toBe(false);
    expect(d("builder", "remove", P.test).allow).toBe(false);
  });

  test("architect may remove only what it may write", () => {
    expect(d("architect", "remove", P.contract).allow).toBe(true);
    expect(d("architect", "remove", P.test).allow).toBe(false);
  });

  test("the reviewer may remove nothing at all — it has no write zone", () => {
    for (const path of ["spec.md", P.contract, P.test, "notes.md"]) {
      expect(d("reviewer", "remove", path).allow, `remove ${path}`).toBe(false);
    }
  });
});

// ADR 2026-054: project config is generated from the composed packs; no role
// writes any of it. Project knowledge stays the architect's alone.
describe("no role may write project config", () => {
  const protection = { dirNames: ["node_modules"], fileNames: ["package.json", "tsconfig*.json", "bun.lock"] };
  const ctx: Ctx = { ...CTX, writeProtection: protection };
  test("every role is refused every write-class tool on a config file, at the root or in a workspace", () => {
    for (const path of ["tsconfig.json", "package.json", "bun.lock", "contexts/pm/package.json", `${ROOT}/tsconfig.json`]) {
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
// stack's tools resolve the nearest dependency directory or manifest before
// the root's, so one inside a role's zone would let that role replace a
// dependency or re-configure a gate. The names are pack data; .git and
// .bounded are the core's.
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
  const ctx: Ctx = { ...CTX, writeProtection: protection };
  const refused = (role: Role, path: string): void => {
    for (const tool of ["write", "edit", "remove"] as const) {
      expect(decide(role, tool, { path }, ctx).allow, `${role} ${tool} ${path}`).toBe(false);
    }
  };

  test("the builder may not plant a dependency or config inside a source root", () => {
    for (const path of [
      `${ROOT}/node_modules/zod/package.json`,
      `${ROOT}/deep/NODE_MODULES/x.js`,
      `${ROOT}/.bounded/x.ts`,
      `${ROOT}/.GIT/config`,
      `${ROOT}/ui/package.json`,
    ]) refused("builder", path);
    expect(decide("builder", "write", { path: P.handler }, ctx).allow).toBe(true);
  });

  test("the test-writer may not either", () => {
    for (const path of [`${ROOT}/node_modules/x.test.ts`, `${ROOT}/.bounded/x.test.ts`, `${ROOT}/.git/x.test.ts`]) {
      refused("test-writer", path);
    }
    expect(decide("test-writer", "write", { path: P.test }, ctx).allow).toBe(true);
  });

  test("the architect may not inside its scratch zone", () => {
    for (const path of ["scratch/node_modules/x.js", "scratch/package.json", "scratch/.git/config"]) refused("architect", path);
    expect(decide("architect", "write", { path: "scratch/probe.ts" }, ctx).allow).toBe(true);
  });

  test("an unreadable protection list refuses every write, and no read", () => {
    const unreadable: Ctx = { ...CTX, writeProtection: "unreadable" };
    expect(decide("test-writer", "write", { path: P.test }, unreadable).allow).toBe(false);
    expect(decide("test-writer", "read", { path: P.test }, unreadable).allow).toBe(true);
  });
});

// The architect's sanctioned scratch zone (Fix 4). Three runs, three models each
// tried to write a throwaway type-probe and were refused, then one smuggled it
// in as a real contract. The zone is top-level and architect-only.
describe("the architect scratch zone", () => {
  test("the architect may write, edit and remove inside scratch/", () => {
    for (const tool of ["write", "edit", "remove"] as const) {
      expect(d("architect", tool, "scratch/probe.ts").allow, tool).toBe(true);
    }
    expect(d("architect", "write", "scratch/deep/nested/probe.ts").allow).toBe(true);
  });

  test("no other role may write it", () => {
    for (const role of ["test-writer", "builder", "reviewer"] as const) {
      expect(d(role, "write", "scratch/probe.test.ts").allow, role).toBe(false);
      expect(ZONES[role].writeAllow).not.toContain("scratch/**");
    }
  });
});

// ADRs 2026-052 and 2026-056: contract files are the composed packs'
// contract globs (source roots × contract suffixes). The core lists none.
describe("pack-contributed contract globs", () => {
  test("the core zones name no contract, root, suffix or generated file", () => {
    expect(ZONES.architect.writeAllow.some((glob) => glob.includes("contract"))).toBe(false);
    for (const role of ["test-writer", "builder", "reviewer"] as const) {
      expect(ZONES[role]).toEqual({ writeAllow: [], writeDeny: [], readDeny: [], readExcept: [] });
    }
  });

  test("another pack's suffix and roots are what the roles see and write", () => {
    const ctx: Ctx = {
      cwd: "/p",
      sourceRoots: ["lib"],
      contractGlobs: ["lib/**/*.iface.py"],
      testSuffixes: [".spec.py"],
      generatedGlobs: [],
    };
    expect(decide("architect", "write", { path: "lib/a/b.iface.py" }, ctx).allow).toBe(true);
    expect(decide("architect", "write", { path: P.contract }, ctx).allow).toBe(false);
    expect(decide("test-writer", "read", { path: "lib/a/b.iface.py" }, ctx).allow).toBe(true);
    expect(decide("test-writer", "read", { path: "lib/a/b.py" }, ctx).allow).toBe(false);
    expect(decide("test-writer", "write", { path: "lib/a/b.spec.py" }, ctx).allow).toBe(true);
    expect(decide("builder", "read", { path: "lib/a/b.spec.py" }, ctx).allow).toBe(false);
    expect(decide("builder", "write", { path: "lib/a/b.iface.py" }, ctx).allow).toBe(false);
    expect(decide("builder", "write", { path: "lib/a/b.py" }, ctx).allow).toBe(true);
    // The TypeScript layout means nothing to this project.
    expect(decide("builder", "write", { path: P.handler }, ctx).allow).toBe(false);
    expect(decide("builder", "read", { path: P.test }, ctx).allow).toBe(true);
  });

  test("a contract must be inside a source root to be one", () => {
    expect(d("architect", "write", "docs/x.contract.ts").allow).toBe(false);
    expect(d("builder", "write", "docs/x.contract.ts").allow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adversarial review, round 1 (ADR 2026-057): three bypasses, pinned
// ---------------------------------------------------------------------------

describe("attack: Unicode case folding (APFS folds 'ſ' U+017F onto 's')", () => {
  // Each of these named, on APFS, a real test or implementation file.
  const folded = [
    `${FEATURE}/create-note.teſt.ts`,
    "contextſ/pm/src/application/notes/create-note/create-note.test.ts",
    `${FEATURE}/create-note.handler.tſ`,
    "contextſ/pm/src/application/notes/create-note/create-note.handler.ts",
    `${FEATURE}/create-note.test.ts `,
    `${FEATURE}/créate.ts`,
  ];

  test.each(folded)("%j is refused to both blind roles for every path tool", (path) => {
    for (const role of ["builder", "test-writer"] as const) {
      for (const tool of ["read", "grep", "ls", "find", "write", "edit", "remove"]) {
        const r = d(role, tool, path, { pattern: "x", glob: "*.handler.ts" });
        expect(r.allow, `${role} ${tool}`).toBe(false);
        expect(reasonOf(r)).toContain("non-ASCII character");
      }
    }
  });

  test("no role may write a non-ASCII name; the reading roles may still read one", () => {
    expect(d("architect", "write", "docs/tn/TN-ſ.md").allow).toBe(false);
    expect(d("architect", "write", `${ROOT}/domain/x.contract.tſ`).allow).toBe(false);
    expect(d("architect", "read", `${FEATURE}/create-note.teſt.ts`).allow).toBe(true);
    expect(d("reviewer", "read", "docs/café.md").allow).toBe(true);
  });

  test("a directory grep is refused when the tree below holds a non-ASCII name", () => {
    const ctx: Ctx = { ...CTX, pathFacts: factsFor([...FILES, `${FEATURE}/other.teſt.ts`]) };
    const single: Ctx = { ...ctx, testSuffixes: [".test.ts"] };
    for (const c of [ctx, single]) {
      for (const glob of ["*.handler.ts", "!*.test.ts"]) {
        const r = d("builder", "grep", ROOT, { pattern: "x", glob }, c);
        expect(reasonOf(r)).toContain(`'${FEATURE}/other.teſt.ts' has a non-ASCII name`);
      }
    }
    expect(d("test-writer", "grep", ROOT, { pattern: "x", glob: "*.test.ts" }, ctx).allow).toBe(false);
  });

  test("a non-ASCII glob is refused", () => {
    expect(reasonOf(d("builder", "grep", ROOT, { pattern: "x", glob: "*.teſt.ts" }))).toContain("non-ASCII character");
    expect(d("test-writer", "grep", ROOT, { pattern: "x", glob: "*.teſt.ts" }).allow).toBe(false);
  });
});

describe("attack: Claude Code's Grep splits a glob on whitespace and commas", () => {
  test.each([
    "*.handler.ts,*.test.ts", "*.handler.ts *.test.ts", "*.handler.ts\t*.test.ts", "*.handler.ts\n*.test.ts",
    "*.handler.ts, *.test.ts", " *.handler.ts", "*.handler.ts ", ",*.handler.ts",
  ])("builder glob %j is refused, naming the legal alternative", (glob) => {
    const r = d("builder", "grep", ROOT, { pattern: "x", glob });
    expect(reasonOf(r)).toContain("has whitespace or a comma, which a host may split into several globs");
    expect(reasonOf(r)).toContain("run one search per glob");
    expect(reasonOf(r)).toContain("'*.<name>.ts'");
  });

  test.each(["*.test.ts,*.handler.ts", "*.test.ts *.handler.ts"])("test-writer glob %j is refused", (glob) => {
    expect(reasonOf(d("test-writer", "grep", ROOT, { pattern: "x", glob }))).toContain("whitespace or a comma");
  });
});

describe("attack: a host rewrites a leading '@', '~' or 'file:' before use", () => {
  // The gate rewrites them as the host does first (host-paths.ts); one that
  // reaches decide() was not rewritten, and is refused rather than guessed.
  test.each([`@${P.test}`, `@@${P.test}`, "~/x", "~", `file://${"/repo"}/${P.test}`, `FILE:${P.test}`])(
    "%j is refused to both blind roles, and to every write",
    (path) => {
      for (const role of ["builder", "test-writer"] as const) {
        for (const tool of ["read", "grep", "ls", "write"]) {
          const r = d(role, tool, path, { pattern: "x" });
          expect(r.allow, `${role} ${tool}`).toBe(false);
        }
      }
      expect(reasonOf(d("architect", "write", path))).toContain("may be rewritten by the host");
    },
  );

  test("a '@' or '~' later in a path is an ordinary character", () => {
    expect(d("builder", "write", `${ROOT}/domain/@x.ts`).allow).toBe(true);
    expect(d("builder", "write", `${ROOT}/domain/~x.ts`).allow).toBe(true);
  });
});
