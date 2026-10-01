import { describe, expect, test } from "vitest";
import { PIPELINE_ROLES } from "../../src/path-gate.ts";
import { ARTIFACT_GATE_TOOLS, GATE_TOOLS, ROLE_TOOLS, type Role } from "../../src/path-policy.ts";
import { SLEEP_MAX_SECONDS, SLEEP_MIN_SECONDS } from "../../src/sleep-bounds.ts";
import { carriers, cliGates, decideBash, gateCommand, shellWords } from "./bash-policy.ts";

// ADR 2026-034: in Claude Code, Bash is the carrier for `bounded gates`, and the
// hook narrows it to exactly the gates in the role's ROLE_TOOLS. Anything else
// — compound commands, redirects, substitutions — is refused with the role's
// forbiddenWhy reason. Table-driven over all four roles so a change to
// ROLE_TOOLS shows up here as a changed row, never as a silent widening.

// The layout comes from composed pack data (ADRs 2026-052, 2026-056…058), as
// the hook passes it.
// The path facts a fake filesystem gives: `contexts/link` is a link (into .git,
// say), and everything else is as written.
const LINKED = new Set(["contexts/link", "contexts/link/x"]);
// Every directory holds both sides; `contexts/pm/links` holds a link and
// `contexts/pm/odd` a non-ASCII name, as a directory search must notice.
const FACTS = {
  kind: (p: string) => (/\.[a-z]+$/.test(p) ? ("file" as const) : ("directory" as const)),
  tree: (dir: string) => ({
    fileNames: ["a.ts", "a.test.ts", "b.handler.ts", "m.contract.ts"],
    links: dir.startsWith("contexts/pm/links") ? ["contexts/pm/links/l.ts"] : [],
    oddNames: dir.startsWith("contexts/pm/odd") ? ["contexts/pm/odd/ſ.ts"] : [],
  }),
  asWritten: (p: string) => !LINKED.has(p.replace(/\/+$/, "")),
};
const CTX = {
  cwd: "/proj",
  sourceRoots: ["contexts/*/src"],
  contractGlobs: ["contexts/*/src/**/*.contract.ts"],
  testSuffixes: [".test.ts"],
  generatedGlobs: ["**/*.laws.test.ts"],
  pathFacts: FACTS,
};
type Verdict = "allow" | "deny";
type Row = readonly [command: string, expected: Readonly<Record<Role, Verdict>>];

const all = (v: Verdict): Readonly<Record<Role, Verdict>> => ({ architect: v, "test-writer": v, builder: v, reviewer: v });
const only = (...roles: Role[]): Readonly<Record<Role, Verdict>> => ({
  architect: roles.includes("architect") ? "allow" : "deny",
  "test-writer": roles.includes("test-writer") ? "allow" : "deny",
  builder: roles.includes("builder") ? "allow" : "deny",
  reviewer: roles.includes("reviewer") ? "allow" : "deny",
});

const TABLE: readonly Row[] = [
  // The gates, by role — the list IS ROLE_TOOLS.
  ["bounded gates typecheck", all("allow")],
  ["bounded gates typecheck --json", all("allow")],
  ["bounded gates typecheck .", all("allow")],
  ["bounded gates red-gate", only("architect")],
  ["bounded gates red_gate", only("architect")], // the pi spelling is accepted too
  ["bounded gates design-gate", only("architect")],
  ["bounded gates deliver", only("architect")],
  ["bounded gates mutation-score", only("architect")],
  ["bounded gates run-tests", only("builder")],
  ["bounded gates record-design-review", only("reviewer")],
  ["bounded gates --list", all("allow")],
  ["bounded gates --help", all("allow")],
  ["bounded gates", all("deny")],
  // Project config is regenerated only by the user (ADR 2026-054), and no role
  // may run the package manager that would rewrite it.
  ["bounded sync-config", all("deny")],
  ["bash .bounded/harness/scripts/bounded sync-config", all("deny")],
  ["npm install left-pad", all("deny")],
  ["bounded gates nosuch", all("deny")],
  ["bounded gates read", all("deny")], // a file tool is not a gate
  // Host-only flags: the role reaches the CLI through the hook's env prefix.
  ["bounded gates typecheck --role architect", all("deny")],
  ["bounded gates typecheck --role=architect", all("deny")],
  ["bounded gates red-gate --role architect", all("deny")],
  ["bounded gates record-design-review --findings-file f.json", all("deny")],
  ["bounded gates --role builder typecheck", all("deny")],
  ["BOUNDED_DEV_STAGE_ROLE=architect bounded gates red-gate", all("deny")], // only the hook adds this
  ["BOUNDED_HOST=claude-code bounded gates red-gate", all("deny")], // and this
  ["BOUNDED_HOST=claude-code BOUNDED_DEV_STAGE_ROLE=architect bounded gates red-gate", all("deny")],
  ["/usr/local/bin/bounded gates typecheck", all("deny")], // only the bare name; a path could be anything
  // git: the architect's read-only history and status carrier.
  ["git status", only("architect")],
  ["git log --oneline -10", only("architect")],
  ["git show HEAD:tests/x.test.ts", only("architect")],
  ["git commit -m \"fix: tidy; and more\"", all("deny")],
  ["git commit -m 'literal $(x) `y`'", all("deny")],
  ["git commit -m \"$(cat notes)\"", all("deny")], // expansion inside double quotes
  ["git -c alias.t=!npm x", all("deny")],
  ["git --exec-path=/tmp/evil status", all("deny")],
  ["git config alias.t '!npm test'", all("deny")],
  ["git config core.hooksPath scratch/hooks", all("deny")], // then `git commit` would be a shell
  // A leading global that takes a value hides the subcommand: refused by name.
  ["git -C . config core.hooksPath scratch/hooks", all("deny")],
  ["git --git-dir .git config core.hooksPath scratch/hooks", all("deny")],
  ["git -C . bisect run npm test", all("deny")],
  ["git -C . rebase -x npm HEAD~3", all("deny")],
  ["git --work-tree=/tmp status", all("deny")],
  ["git --no-pager log", only("architect")],
  ["git -P --no-optional-locks status", only("architect")],
  ["git config --get core.hooksPath", all("deny")],
  ["git config --list", all("deny")],
  ["git bisect run npm test", all("deny")],
  ["git bisect start", all("deny")],
  ["git rebase -x 'npm test' HEAD~3", all("deny")],
  ["git rebase --exec=npm HEAD~3", all("deny")],
  ["git rebase -i HEAD~3", all("deny")],
  ["git add -f .bounded/harness/scripts/bounded", all("deny")],
  ["git update-index --chmod=+x .bounded/harness/scripts/bounded", all("deny")],
  ["git checkout-index -f -- .bounded/harness/scripts/bounded", all("deny")],
  ["git diff --output=src/crm/model.ts", all("deny")],
  ["git filter-branch --tree-filter 'rm x' HEAD", all("deny")],
  ["git submodule foreach npm test", all("deny")],
  ["git difftool", all("deny")],
  // sleep: the architect's, bounded like the pi tool.
  ["sleep 30", only("architect")],
  ["sleep 1", only("architect")],
  ["sleep 120", only("architect")],
  ["sleep 0", all("deny")],
  ["sleep 121", all("deny")],
  ["sleep 5 5", all("deny")],
  ["sleep abc", all("deny")],
  // rm: one path, judged as a pi `remove` — so the write zones apply.
  ["rm contexts/m/src/a.test.ts", only("test-writer")],
  ["rm /proj/contexts/m/src/a.test.ts", only("test-writer")],
  ["rm contexts/m/src/x.ts", only("builder")],
  ["rm /proj/contexts/m/src/x.ts", only("builder")],
  ["rm contexts/m/src/x.contract.ts", only("architect")],
  ["rm spec.md", only("architect")],
  ["rm .bounded/guard-log.jsonl", all("deny")],
  ["rm -rf src", all("deny")],
  ["rm src/*.ts", all("deny")],
  ["rm 'src/*.ts'", all("deny")], // a pattern is refused even when quoted
  ["rm ~/x", all("deny")],
  ["rm a b", all("deny")],
  ["rm", all("deny")],
  // Everything else.
  ["npm test", all("deny")],
  ["npx vitest run", all("deny")],
  ["cat tests/a.test.ts", all("deny")],
  // Names-only listing (#35): every role, judged as pi's ls/find.
  ["ls", all("allow")],
  ["ls .", all("allow")],
  ["ls -1aF contexts/pm/src", all("allow")],
  ["find contexts/pm/src -name '*.test.ts'", all("allow")],
  ["find contexts/pm/src -type f -name '*.ts' -maxdepth 3", all("allow")],
  ["find contexts -ipath '*/src/*' -print", all("allow")],
  ["ls .git", all("deny")],
  ["ls -R contexts", all("deny")],
  ["ls -l contexts", all("deny")],
  ["ls contexts apps", all("deny")],
  ["find . -name '*.ts'", all("deny")], // recursive over the tree that holds .git
  ["find contexts -name *.ts", all("deny")], // an unquoted glob is the shell's, not find's
  ["find contexts -exec cat {} ;", all("deny")],
  ["find contexts -name '*.ts' -delete", all("deny")],
  ["find -L contexts -name '*.ts'", all("deny")],
  ["find contexts -name '*.ts' -o -name '*.tsx'", all("deny")],
  ["find contexts -path '../**'", all("deny")],
  ["find contexts -path '/etc/*'", all("deny")],
  ["find /etc -name passwd", all("deny")],
  ["ls ../outside", all("deny")],
  ["ls contexts && cat contexts/pm/src/a.test.ts", all("deny")],
  ["node -e 1", all("deny")],
  ["", all("deny")],
  ["   ", all("deny")],
  // Compound forms: refused whatever they start with.
  ["bounded gates typecheck && cat tests/a.test.ts", all("deny")],
  ["bounded gates typecheck; cat tests/a.test.ts", all("deny")],
  ["bounded gates typecheck || true", all("deny")],
  ["bounded gates typecheck | head", all("deny")],
  ["bounded gates typecheck > out.txt", all("deny")],
  ["bounded gates typecheck < in.txt", all("deny")],
  ["bounded gates typecheck &", all("deny")],
  ["bounded gates $(echo typecheck)", all("deny")],
  ["bounded gates `echo typecheck`", all("deny")],
  ["bounded gates typecheck\ncat tests/a.test.ts", all("deny")],
  ["PATH=/tmp bounded gates typecheck", all("deny")],
  ["bounded gates typecheck (x)", all("deny")],
  ["bounded gates {typecheck,deliver}", all("deny")],
  ["bounded gates 'typecheck", all("deny")], // unterminated quote
  ["bounded gates typ\\echeck", all("deny")], // backslash escape
];

describe("decideBash — the decision table over all four roles", () => {
  for (const [command, expected] of TABLE) {
    for (const role of PIPELINE_ROLES) {
      test(`${role}: ${JSON.stringify(command)} → ${expected[role]}`, () => {
        const d = decideBash(role, command, CTX);
        expect(d.allow ? "allow" : "deny").toBe(expected[role]);
        if (!d.allow) {
          // Every refusal is one greppable line naming the role.
          expect(d.reason.startsWith(`path-gate: ${role} may not `)).toBe(true);
          expect(d.reason).not.toContain("\n");
        }
      });
    }
  }
});

describe("refusal reasons — specific, and the pi wording where pi has one", () => {
  test("a shell command outside the carriers gets forbiddenWhy(role, 'bash') plus this host's list", () => {
    const d = decideBash("builder", "npm test", CTX);
    expect(d).toMatchObject({ allow: false });
    if (!d.allow) {
      expect(d.reason).toBe(
        "path-gate: builder may not run 'npm': no role holds a shell — use read/grep/find/ls, run_tests, or typecheck — in Claude Code, Bash carries only bounded gates <gate>, rm <path>, ls [<dir>], find <dir> -name '<glob>', grep -rn [--include='<glob>'] -e '<pattern>' <path>",
      );
    }
  });
  test("a gate another role holds is refused with pi's reason for that tool", () => {
    const d = decideBash("builder", "bounded gates red-gate", CTX);
    if (!d.allow) expect(d.reason).toBe("path-gate: builder may not run 'bounded gates red-gate': 'red_gate' is the architect's — use read/grep/find/ls, run_tests, or typecheck");
    const a = decideBash("architect", "bounded gates run-tests", CTX);
    if (!a.allow) expect(a.reason).toContain("run_tests is the builder's blind-safe channel — run red_gate/green_gate instead");
  });
  test("an unknown gate names the role's own gates", () => {
    const d = decideBash("test-writer", "bounded gates nosuch", CTX);
    if (!d.allow) expect(d.reason).toBe("path-gate: test-writer may not run 'bounded gates nosuch': no such gate for this role — test-writer's gates are typecheck");
  });
  test("a compound command names the construct and the carriers", () => {
    const d = decideBash("architect", "bounded gates typecheck && cat x", CTX);
    if (!d.allow) {
      expect(d.reason).toContain("a background/and operator ('&')");
      expect(d.reason).toContain("Bash here carries only bounded gates <gate>, git …, sleep <1-120>, rm <path>");
    }
  });
  test("a leading git global is refused by name, with the safe set", () => {
    const d = decideBash("architect", "git -C . config core.hooksPath scratch/hooks", CTX);
    if (!d.allow) {
      expect(d.reason).toBe(
        "path-gate: architect may not run 'git -C . config core.hooksPath scratch/hooks': git '-C' before the subcommand is a global option this host does not pass (only --no-pager, -P, --no-optional-locks, --literal-pathspecs)",
      );
    }
  });
  test("rm outside the zone gets decide()'s own zone reason", () => {
    const d = decideBash("builder", "rm contexts/m/src/a.test.ts", CTX);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("path-gate: builder may not write 'contexts/m/src/a.test.ts': it is a test file (name ends with '.test.ts') — the test-writer's; you may list its name, never read or write it");
    }
    const r = decideBash("reviewer", "rm spec.md", CTX);
    if (!r.allow) expect(r.reason).toContain("reviewer has no write zone");
  });
  test("rm of a generated file is refused to every role", () => {
    for (const role of PIPELINE_ROLES) {
      expect(decideBash(role, "rm contexts/m/src/x.laws.test.ts", CTX).allow, role).toBe(false);
    }
  });
  test("a ctx without the layout refuses every blind role's rm (fail closed)", () => {
    const bare = { cwd: "/proj" };
    expect(decideBash("builder", "rm contexts/m/src/x.ts", bare).allow).toBe(false);
    expect(decideBash("test-writer", "rm contexts/m/src/a.test.ts", bare).allow).toBe(false);
  });
  test("a long command is quoted bounded, on one line", () => {
    const d = decideBash("builder", `npm ${"x".repeat(200)}`, CTX);
    if (!d.allow) expect(d.reason.length).toBeLessThan(400);
  });
});

describe("an allow names its carrier, so the hook knows which to decorate", () => {
  test.each([
    ["bounded gates typecheck", "bounded gates"],
    ["bounded gates --list", "bounded gates"],
    ["git status", "git"],
    ["sleep 5", "sleep"],
    ["rm spec.md", "rm"],
  ] as const)("architect: %s → carrier %s", (command, carrier) => {
    expect(decideBash("architect", command, CTX)).toEqual({ allow: true, carrier });
  });
  test("a host-only flag is refused by name", () => {
    const d = decideBash("builder", "bounded gates typecheck --role architect", CTX);
    if (!d.allow) expect(d.reason).toBe("path-gate: builder may not pass '--role' to bounded gates: the host supplies the role and findings are passed inline");
  });
});

describe("cliGates — derived from ROLE_TOOLS, never a second list", () => {
  test.each(PIPELINE_ROLES)("%s: every gate is in ROLE_TOOLS and no file/carrier tool is a gate", (role) => {
    for (const gate of cliGates(role)) expect(ROLE_TOOLS[role]).toContain(gate);
    for (const notGate of ["read", "grep", "find", "ls", "write", "edit", "remove", "subagent", "git", "sleep", "bash"]) {
      expect(cliGates(role)).not.toContain(notGate);
    }
  });
  test("the architect holds every GATE_TOOLS entry as a CLI gate", () => {
    for (const gate of GATE_TOOLS) expect(cliGates("architect")).toContain(gate);
  });
  test("the CLI gates are exactly ROLE_TOOLS ∩ ARTIFACT_GATE_TOOLS (derived, not restated)", () => {
    for (const role of PIPELINE_ROLES) {
      expect(cliGates(role)).toEqual(ROLE_TOOLS[role].filter((t) => ARTIFACT_GATE_TOOLS.includes(t)));
    }
  });
  test("the sleep bounds are the shared ones", () => {
    expect(decideBash("architect", `sleep ${SLEEP_MIN_SECONDS}`, CTX)).toEqual({ allow: true, carrier: "sleep" });
    expect(decideBash("architect", `sleep ${SLEEP_MAX_SECONDS}`, CTX)).toEqual({ allow: true, carrier: "sleep" });
    expect(decideBash("architect", `sleep ${SLEEP_MAX_SECONDS + 1}`, CTX)).toMatchObject({ allow: false });
  });
  test("the CLI spelling is hyphenated", () => {
    expect(gateCommand("red_gate")).toBe("red-gate");
    expect(gateCommand("record_design_review")).toBe("record-design-review");
  });
  test("carriers names exactly what each role may put through Bash", () => {
    const listing = "ls [<dir>], find <dir> -name '<glob>', grep -rn [--include='<glob>'] -e '<pattern>' <path>";
    expect(carriers("architect")).toBe(`bounded gates <gate>, git …, sleep <1-120>, rm <path>, ${listing}`);
    expect(carriers("builder")).toBe(`bounded gates <gate>, rm <path>, ${listing}`);
    expect(carriers("reviewer")).toBe(`bounded gates <gate>, ${listing}`);
  });
});

// #35, adversarially: content search through Bash is judged exactly as pi's
// grep (ADR 2026-057). A blind role reads nothing of the other side: not one
// file, not a directory without a glob that provably excludes it, not a tree
// with a link or an odd name, not through a link.
describe("grep through Bash keeps each blind role off the other side", () => {
  const S = "contexts/pm/src";
  const v = (role: Role, command: string): Verdict => (decideBash(role, command, CTX).allow ? "allow" : "deny");
  test.each([
    // [command, builder, test-writer, architect, reviewer]
    [`grep -rn -e 'x' ${S}`, "deny", "deny", "allow", "allow"],
    [`grep -rn --include='*.handler.ts' -e 'x' ${S}`, "allow", "deny", "allow", "allow"],
    [`grep -rn --include='*.test.ts' -e 'x' ${S}`, "deny", "allow", "allow", "allow"],
    [`grep -rn --include='*.ts' -e 'x' ${S}`, "deny", "deny", "allow", "allow"],
    [`grep -rn --include='*test.ts' -e 'x' ${S}`, "deny", "deny", "allow", "allow"],
    [`grep -n 'x' ${S}/a.test.ts`, "deny", "allow", "allow", "allow"],
    [`grep -n 'x' ${S}/A.TEST.TS`, "deny", "deny", "allow", "allow"],
    [`grep -n 'x' ${S}/a.ts`, "allow", "deny", "allow", "allow"],
    [`grep -n 'x' ${S}/m.contract.ts`, "allow", "allow", "allow", "allow"],
    [`grep -rn --include='*.handler.ts' -e 'x' contexts/pm/links`, "deny", "deny", "allow", "allow"],
    [`grep -rn --include='*.handler.ts' -e 'x' contexts/pm/odd`, "deny", "deny", "allow", "allow"],
    ["grep -rn -e 'x' contexts/link", "deny", "deny", "deny", "deny"],
    ["grep -rn -e 'x' .", "deny", "deny", "deny", "deny"],
    ["grep -rn -e 'x' .git", "deny", "deny", "deny", "deny"],
    ["grep -rn -e 'x' ../outside", "deny", "deny", "deny", "deny"],
    [`grep -rn -f ${S}/a.test.ts ${S}/a.ts`, "deny", "deny", "deny", "deny"],
    [`grep -rn -e 'x' ${S}/a.ts ${S}/a.test.ts`, "deny", "deny", "deny", "deny"],
    [`grep -R --include='*.handler.ts' -e 'x' ${S}`, "deny", "deny", "deny", "deny"],
    [`grep -rn -e 'x' ${S} | head`, "deny", "deny", "deny", "deny"],
    [`grep -rn -e 'x' ${S}/a.ts > out.txt`, "deny", "deny", "deny", "deny"],
  ] as const)("%s → builder %s, test-writer %s, architect %s, reviewer %s", (command, b, t, a, r) => {
    expect(v("builder", command)).toBe(b);
    expect(v("test-writer", command)).toBe(t);
    expect(v("architect", command)).toBe(a);
    expect(v("reviewer", command)).toBe(r);
  });
  test("an allowed search is carried as grep", () => {
    expect(decideBash("builder", `grep -n 'x' ${S}/a.ts`, CTX)).toEqual({ allow: true, carrier: "grep" });
  });
});

// #35, adversarially: a listing shows names, never contents. Names of the other
// side are fine (ADR 2026-057); everything that could print, run, follow or
// escape is refused before the gate is even asked.
describe("listing through Bash stays names-only and blind-safe", () => {
  test("a blind role may list and find the other side's NAMES", () => {
    expect(decideBash("builder", "find contexts/pm/src -name '*.test.ts'", CTX)).toEqual({ allow: true, carrier: "find" });
    expect(decideBash("test-writer", "find contexts/pm/src -name '*.handler.ts'", CTX)).toEqual({ allow: true, carrier: "find" });
    expect(decideBash("builder", "ls contexts/pm/src", CTX)).toEqual({ allow: true, carrier: "ls" });
  });
  test.each([
    "ls contexts/pm/src/a.test.ts contexts/pm/src/b.test.ts", // two paths: more than one listing
    "find contexts/pm/src -name '*.test.ts' -exec cat {} +",
    "find contexts/pm/src -name '*.test.ts' -fprint out",
    "find contexts/pm/src -name '*.test.ts' -ls",
    "find contexts/pm/src -newer contexts/pm/src/a.test.ts",
    "find contexts/pm/src -regex '.*test.*'",
    "find -H contexts/pm/src",
    "find contexts/pm/src ! -name x",
    "ls --color=always contexts",
    "ls -s contexts",
    "ls -L contexts",
    "ls contexts | head",
    "find contexts/pm/src -name '*.test.ts' > list.txt",
    "find $(pwd) -name x",
    "find ~ -name x",
    "find .git -name config",
    "find contexts/../.git -name config",
  ])("refused: %s", (command) => {
    for (const role of ["builder", "test-writer"] as const) {
      const d = decideBash(role, command, CTX);
      expect(d.allow, `${role}: ${command}`).toBe(false);
    }
  });
  test.each(["ls contexts/link", "ls contexts/link/", "find contexts/link -name '*'", "find contexts/link/ -type f", "ls contexts/link/x"])(
    "a link argument, or a path through one, is refused for every role: %s",
    (command) => {
      for (const role of PIPELINE_ROLES) {
        const d = decideBash(role, command, CTX);
        expect(d.allow, `${role}: ${command}`).toBe(false);
        if (!d.allow) expect(d.reason).toContain("is a link, or reached through one");
      }
    },
  );
  test("without the host's path facts no listing runs (fail closed)", () => {
    const { pathFacts: _drop, ...bare } = CTX;
    expect(decideBash("architect", "ls contexts", bare).allow).toBe(false);
  });
  test("a refused listing says what listing is allowed", () => {
    const d = decideBash("builder", "ls -R contexts", CTX);
    if (d.allow) throw new Error("expected a refusal");
    expect(d.reason).toContain("ls [-1aAFp] [<dir>]");
  });
});

describe("shellWords — the shell's reading, or the construct that stops it", () => {
  test("plain words and quotes", () => {
    expect(shellWords("git commit -m 'a b' \"c d\"")).toEqual({ ok: true, argv: ["git", "commit", "-m", "a b", "c d"] });
    expect(shellWords("  bounded gates\ttypecheck  ")).toEqual({ ok: true, argv: ["bounded", "gates", "typecheck"] });
  });
  test("a comment at word start is refused; '#' inside a word is text", () => {
    expect(shellWords("git log # x")).toMatchObject({ ok: false });
    expect(shellWords("git log --grep=#12")).toEqual({ ok: true, argv: ["git", "log", "--grep=#12"] });
  });
});
