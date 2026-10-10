import { describe, expect, test } from "bun:test";
import { AgentName, Effect } from "bounded/domain";
import { FileSetFingerprint } from "./file-set-fingerprint.ts";
import { PendingAgentRun } from "./pending-agent-run.ts";
import { PrerequisiteRecord } from "./prerequisite-record.ts";
import { PrerequisiteRule } from "./prerequisite-rule.ts";
import type { CannotSeeFix } from "./program-prefix.contract.ts";

const beforeBuilder = { before: { delegate: "builder" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan" };
const beforeSrc = { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" };
const beforeTests = { before: { delegate: "test-writer" }, require: { delegate: "spec-reviewer", succeeded: true }, unchangedSince: ["spec.md", "src/**/*.contract.ts"], redirect: "Have spec-reviewer review the current spec and contracts" };
const beforeApply = { before: { execute: "terraform apply" }, require: { delegate: "infra-reviewer", succeeded: true }, unchangedSince: ["infra/**"], redirect: "Have infra-reviewer review the current infra/ changes" };

const rule = (raw: unknown): PrerequisiteRule => {
  const parsed = PrerequisiteRule.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const error = (raw: unknown): string => {
  const parsed = PrerequisiteRule.parse(raw);
  return parsed.ok ? "accepted" : parsed.error;
};
const effect = (raw: unknown): Effect => {
  const parsed = Effect.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const agent = (name: string): AgentName => {
  const parsed = AgentName.parse(name);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const fingerprint = (sha: string, fileCount = 1): FileSetFingerprint => {
  const parsed = FileSetFingerprint.parse({ sha256: sha.repeat(64), fileCount });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const record = (delegate: string, unchangedSince: readonly string[], sha: string): PrerequisiteRecord => {
  const parsed = PrerequisiteRecord.parse({ delegate, unchangedSince, fingerprint: { sha256: sha.repeat(64), fileCount: 1 }, callId: `c-${sha}` });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

describe("PrerequisiteRule — an action that needs a delegation to have succeeded over unchanged files", () => {
  test("the four canonical rules parse, and their wire form is what was written", () => {
    for (const raw of [beforeBuilder, beforeSrc, beforeTests, beforeApply]) {
      expect<unknown>(rule(raw).toJSON()).toEqual(raw);
      expect(JSON.parse(JSON.stringify(rule(raw)))).toEqual(raw);
    }
    expect<unknown>(rule({ ...beforeSrc, unchangedSince: ["./.agent-state//*/plan.md"], redirect: " Review it " }).toJSON()).toEqual({ ...beforeSrc, unchangedSince: [".agent-state/*/plan.md"], redirect: "Review it" });
    expect(Object.isFrozen(rule(beforeSrc))).toBe(true);
  });

  test("a rule is { before, require, unchangedSince, redirect }", () => {
    const form = "A prerequisite rule is { before, require, unchangedSince, redirect }";
    const { redirect, ...withoutRedirect } = beforeSrc;
    expect(error({ ...withoutRedirect, fix: redirect })).toBe(form);
    expect(error({ ...beforeSrc, fix: "x" })).toBe(form);
    expect(error(withoutRedirect)).toBe(form);
    for (const raw of [null, "rule", [], 3]) expect(error(raw)).toBe(form);
  });

  test("a rule's before names one action: a delegation, a write or an execute", () => {
    const one = "A rule's before names one action: { delegate: <agent> }, { write: <pattern> } or { execute: <program and leading arguments> }";
    const execute = "A rule's before.execute is a program and its leading arguments as the program receives them, separated by spaces: ";
    expect<unknown>(rule({ ...beforeSrc, before: { execute: "terraform apply" } }).toJSON()).toEqual({ ...beforeSrc, before: { execute: "terraform apply" } });
    expect(error({ ...beforeSrc, before: {} })).toBe(one);
    expect(error({ ...beforeSrc, before: { delegate: "builder", write: "src/**" } })).toBe(one);
    expect(error({ ...beforeSrc, before: { execute: "terraform apply", write: "src/**" } })).toBe(one);
    expect(error({ ...beforeSrc, before: { execute: "terraform apply", delegate: "builder" } })).toBe(one);
    expect(error({ ...beforeSrc, before: "src/**" })).toBe(one);
    expect(error({ ...beforeSrc, before: { delegate: " " } })).toStartWith("A rule's before.delegate: ");
    expect(error({ ...beforeSrc, before: { write: "../x" } })).toContain("A rule's before.write pattern '../x' uses '..'");
    expect(error({ ...beforeSrc, before: { execute: "$TF apply" } })).toBe(`${execute}it holds '$', which the shell would read, not pass on`);
    expect(error({ ...beforeSrc, before: { execute: ["terraform", "apply"] } })).toBe(`${execute}it is not text`);
    expect(error({ ...beforeSrc, before: { execute: "terraform -auto-approve" } })).toBe(`${execute}'-auto-approve' starts with '-': a rule names its program and subcommand words, never an option`);
  });

  test("a rule requires a delegation that succeeded", () => {
    const form = "A rule's require is { delegate, succeeded: true }: a delegation to an agent that succeeded";
    expect(error({ ...beforeSrc, require: { delegate: "plan-reviewer", succeeded: false } })).toBe(form);
    expect(error({ ...beforeSrc, require: { delegate: "plan-reviewer" } })).toBe(form);
    expect(error({ ...beforeSrc, require: { write: "x", succeeded: true } })).toBe(form);
    expect(error({ ...beforeSrc, require: "plan-reviewer" })).toBe(form);
    expect(error({ ...beforeSrc, require: { delegate: "", succeeded: true } })).toStartWith("A rule's require names no agent: ");
  });

  test("a rule cannot require the action it comes before", () => {
    expect(error({ ...beforeBuilder, before: { delegate: "plan-reviewer" } })).toBe("A rule cannot require the action it comes before: delegating to plan-reviewer");
    expect(error({ ...beforeBuilder, before: { delegate: "Plan-Reviewer" } })).toBe("A rule cannot require the action it comes before: delegating to Plan-Reviewer");
  });

  test("a rule names the files that must not change", () => {
    expect(error({ ...beforeSrc, unchangedSince: [] })).toBe("A rule's unchangedSince is a non-empty list of file patterns");
    expect(error({ ...beforeSrc, unchangedSince: "spec.md" })).toBe("A rule's unchangedSince is a non-empty list of file patterns");
    expect(error({ ...beforeSrc, unchangedSince: ["spec.md", "/etc/x"] })).toContain("A rule's unchangedSince pattern '/etc/x' is absolute");
    expect(error({ ...beforeSrc, unchangedSince: [".bounded/**"] })).toContain("is inside .bounded");
  });

  test("a redirect is text without control characters, at most 1000 characters", () => {
    expect(error({ ...beforeSrc, redirect: " " })).toBe("A rule's redirect must say what to do instead");
    expect(error({ ...beforeSrc, redirect: 1 })).toBe("A rule's redirect must say what to do instead");
    expect(error({ ...beforeSrc, redirect: "a\u001bb" })).toBe("A rule's redirect must not contain control characters");
    expect(error({ ...beforeSrc, redirect: "x".repeat(1001) })).toBe("A rule's redirect must be at most 1000 characters");
    expect(error({ ...beforeSrc, redirect: "x".repeat(1000) })).toBe("accepted");
  });

  test("a rule comes before a delegation to its agent, or a write its pattern matches, ignoring case", () => {
    expect(rule(beforeBuilder).comesBefore(effect({ kind: "delegate", agent: "builder" }))).toBe(true);
    expect(rule(beforeBuilder).comesBefore(effect({ kind: "delegate", agent: "Builder" }))).toBe(true);
    expect(rule(beforeBuilder).comesBefore(effect({ kind: "delegate", agent: "builder-2" }))).toBe(false);
    expect(rule(beforeBuilder).comesBefore(effect({ kind: "write", path: "builder", change: "create" }))).toBe(false);
    expect(rule(beforeSrc).comesBefore(effect({ kind: "write", path: "src/a.ts", change: "modify" }))).toBe(true);
    expect(rule(beforeSrc).comesBefore(effect({ kind: "write", path: "SRC/a.ts", change: "delete" }))).toBe(true);
    expect(rule(beforeSrc).comesBefore(effect({ kind: "write", path: "docs/a.md", change: "create" }))).toBe(false);
    expect(rule(beforeSrc).comesBefore(effect({ kind: "read", path: "src/a.ts" }))).toBe(false);
    expect(rule(beforeSrc).comesBefore(effect({ kind: "execute", command: "echo x > src/a.ts", reading: { outcome: "unread", why: "the parser could not load" } }))).toBe(false);
    expect(rule(beforeSrc).describeBefore()).toBe("before write 'src/**'");
    expect(rule(beforeBuilder).describeBefore()).toBe("before delegating to 'builder'");
  });

  test("a before.write rule over node_modules or .git comes before a write there, as the protected-paths pack matches", () => {
    // The final review's repro: such a rule parsed but never fired.
    const overDependencies = rule({ ...beforeSrc, before: { write: "node_modules/**" } });
    expect(overDependencies.comesBefore(effect({ kind: "write", path: "node_modules/left-pad/index.js", change: "modify" }))).toBe(true);
    const overGit = rule({ ...beforeSrc, before: { write: ".git/**" } });
    expect(overGit.comesBefore(effect({ kind: "write", path: ".git/hooks/pre-commit", change: "create" }))).toBe(true);
    expect(error({ ...beforeSrc, unchangedSince: [".git/config"] })).toContain("leads into .git, which is never fingerprinted");
    expect(error({ ...beforeSrc, unchangedSince: ["node_modules/x/**"] })).toContain("leads into node_modules, which is never fingerprinted");
  });

  test("a rule's requirement is met by a delegation to its required agent, by its exact name", () => {
    expect(rule(beforeSrc).requiresDelegationTo(agent("plan-reviewer"))).toBe(true);
    expect(rule(beforeSrc).requiresDelegationTo(agent("PLAN-REVIEWER"))).toBe(false);
    expect(rule(beforeSrc).requiresDelegationTo(agent("spec-reviewer"))).toBe(false);
    expect(rule(beforeSrc).requirementKey()).toBe(rule(beforeBuilder).requirementKey());
    expect(rule(beforeSrc).requirementKey()).not.toBe(rule(beforeTests).requirementKey());
  });

  test("before.delegate folds case and surrounding spaces, so it catches every spelling a host may resolve; require matches exactly", () => {
    // Claude Code 2.1.294 runs plan-reviewer for subagent_type "Plan-Reviewer": a before rule must not be dodged by spelling.
    const builder = rule(beforeBuilder);
    for (const name of ["builder", "Builder", "BUILDER", " builder "]) expect(builder.comesBefore(effect({ kind: "delegate", agent: name }))).toBe(true);
    expect(builder.comesBefore(effect({ kind: "delegate", agent: "builders" }))).toBe(false);
    expect(rule({ ...beforeBuilder, before: { delegate: " Builder " } }).comesBefore(effect({ kind: "delegate", agent: "builder" }))).toBe(true);
    // A rule whose before folds to its required agent requires the action it comes before.
    expect(error({ ...beforeBuilder, before: { delegate: " PLAN-reviewer " } })).toContain("A rule cannot require the action it comes before");
    expect(builder.requiresDelegationTo(agent("plan-reviewer"))).toBe(true);
    expect(builder.requiresDelegationTo(agent("Plan-reviewer"))).toBe(false);
    expect(rule({ ...beforeBuilder, require: { delegate: "Plan-Reviewer", succeeded: true } }).requirementKey()).not.toBe(builder.requirementKey());
    expect(rule(beforeSrc).comesBefore(effect({ kind: "write", path: "Src/A.ts", change: "modify" }))).toBe(true);
  });

  test("a rule holds, is stale or is missing against records of its exact agent and the current fingerprint", () => {
    const plan = [".agent-state/*/plan.md"];
    const now = fingerprint("a");
    expect(rule(beforeSrc).status([], now)).toBe("missing");
    expect(rule(beforeSrc).status([record("spec-reviewer", plan, "a"), record("plan-reviewer", ["other.md"], "a")], now)).toBe("missing");
    expect(rule(beforeSrc).status([record("plan-reviewer", plan, "b")], now)).toBe("stale");
    // A record of Plan-Reviewer is another agent's: it does not count.
    expect(rule(beforeSrc).status([record("plan-reviewer", plan, "b"), record("Plan-Reviewer", plan, "a")], now)).toBe("stale");
    // Files back as they were reviewed: an older record holds again.
    expect(rule(beforeSrc).status([record("plan-reviewer", plan, "a"), record("plan-reviewer", plan, "b")], now)).toBe("holds");
    // Patterns that match no file are never satisfied.
    expect(rule(beforeSrc).status([record("plan-reviewer", plan, "a")], fingerprint("a", 0))).toBe("missing");
  });

  test("a rule no record meets waits on a pending run over its files as they are now", () => {
    const plan = [".agent-state/*/plan.md"];
    const now = fingerprint("a");
    const pendingRun = (agentRunId: string, delegate: string, sha: string, unchangedSince: readonly string[] = plan): PendingAgentRun => {
      const parsed = PendingAgentRun.parse({ agentRunId, callId: `c-${agentRunId}`, startedAt: "2026-10-09T12:00:00.000Z", starts: [{ delegate, unchangedSince, fingerprint: { sha256: sha.repeat(64), fileCount: 1 } }] });
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    };
    const waiting = pendingRun("a1", "plan-reviewer", "a");
    expect(rule(beforeSrc).status([], now, [waiting])).toBe("pending");
    expect(rule(beforeSrc).pendingRun([waiting], now)?.agentRunId.value).toBe("a1");
    // A record that holds wins over a pending run.
    expect(rule(beforeSrc).status([record("plan-reviewer", plan, "a")], now, [waiting])).toBe("holds");
    // A stale record does not stop a pending run over the files as they are now.
    expect(rule(beforeSrc).status([record("plan-reviewer", plan, "b")], now, [waiting])).toBe("pending");
    // A pending run over files that have changed since, or for another requirement, is not waited on.
    expect(rule(beforeSrc).status([], now, [pendingRun("a2", "plan-reviewer", "b")])).toBe("missing");
    expect(rule(beforeSrc).status([record("plan-reviewer", plan, "b")], now, [pendingRun("a2", "plan-reviewer", "b")])).toBe("stale");
    expect(rule(beforeSrc).status([], now, [pendingRun("a3", "spec-reviewer", "a"), pendingRun("a4", "plan-reviewer", "a", ["other.md"])])).toBe("missing");
    expect(rule(beforeSrc).pendingRun([pendingRun("a2", "plan-reviewer", "b")], now)).toBeUndefined();
    // Without pending runs, as before.
    expect(rule(beforeSrc).status([], now)).toBe("missing");
    // Patterns that match no file are never satisfied, pending or not.
    expect(rule(beforeSrc).status([], fingerprint("a", 0), [waiting])).toBe("missing");
  });

  test("a delegation may resolve to a rule's required agent when its requested name matches ignoring case and surrounding spaces", () => {
    const reviewed = rule(beforeSrc);
    for (const name of ["plan-reviewer", "Plan-Reviewer", " plan-reviewer ", "PLAN-REVIEWER"]) expect(reviewed.mayResolveToRequiredAgent(agent(name))).toBe(true);
    expect(reviewed.mayResolveToRequiredAgent(agent("spec-reviewer"))).toBe(false);
    expect(reviewed.mayResolveToRequiredAgent(agent("plan-reviewers"))).toBe(false);
    // requiresDelegationTo stays exact: it is applied to the agent the host resolved.
    expect(reviewed.requiresDelegationTo(agent("Plan-Reviewer"))).toBe(false);
    expect(reviewed.requiresDelegationTo(agent("plan-reviewer"))).toBe(true);
  });

  test("before.delegate folds case by lower-casing, upper-casing, then lower-casing again, so it matches every spelling today's fold matches and more ('straße', 'STRASSE', 'ẞ'); require stays exact", () => {
    const delegation = (name: string): Effect => effect({ kind: "delegate", agent: name });
    const before = (name: string): PrerequisiteRule => rule({ ...beforeBuilder, before: { delegate: name } });
    expect(before("straße").comesBefore(delegation("STRASSE"))).toBe(true);
    expect(before("straße").comesBefore(delegation("Strasse"))).toBe(true);
    // The capital sharp s and the sharp s still match each other, and both match "SS".
    expect(before("ẞ").comesBefore(delegation("ß"))).toBe(true);
    expect(before("ß").comesBefore(delegation("ẞ"))).toBe(true);
    expect(before("ẞ").comesBefore(delegation("SS"))).toBe(true);
    // A rule whose before folds to its required agent requires the action it comes before.
    expect(error({ ...beforeBuilder, before: { delegate: "STRASSE" }, require: { delegate: "straße", succeeded: true } })).toContain("A rule cannot require the action it comes before");
    const requiresStrasse = rule({ ...beforeSrc, require: { delegate: "straße", succeeded: true } });
    expect(requiresStrasse.requiresDelegationTo(agent("STRASSE"))).toBe(false);
    expect(requiresStrasse.mayResolveToRequiredAgent(agent("STRASSE"))).toBe(true);
    const requiresCapitalSharpS = rule({ ...beforeSrc, require: { delegate: "ẞ", succeeded: true } });
    expect(requiresCapitalSharpS.mayResolveToRequiredAgent(agent("ß"))).toBe(true);
    expect(requiresCapitalSharpS.mayResolveToRequiredAgent(agent("SS"))).toBe(true);
    // The fold is a function of the lower-cased name: every pair lower-casing alone matches still matches.
    const unmatchedCodePoints: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      const name = `x${String.fromCharCode(code)}x`;
      if (!AgentName.parse(name).ok) continue;
      const parsed = PrerequisiteRule.parse({ ...beforeBuilder, before: { delegate: name } });
      if (!parsed.ok || !parsed.value.comesBefore(delegation(name.toLowerCase()))) unmatchedCodePoints.push(code.toString(16));
    }
    expect(unmatchedCodePoints).toEqual([]);
  });
});

/** A word only the shell can resolve, as the reader reports it. */
const unresolvedWord = (text: string) => ({ kind: "unresolved", text });
type Word = string | ReturnType<typeof unresolvedWord>;
const wordOf = (word: Word) => (typeof word === "string" ? { kind: "literal", text: word } : word);
const ran = (name: Word, args: readonly Word[] = []) => ({ name: wordOf(name), arguments: args.map(wordOf), workingDirectory: "." });
/** An execute effect of `command`, read as running `programs`, with `fileEffects` and `parts` left unresolved. */
const shell = (command: string, programs: readonly object[], fileEffects: readonly object[] = [], parts: readonly object[] = [], cwd?: string): Effect =>
  effect({ kind: "execute", command, ...(cwd === undefined ? {} : { cwd }), reading: { outcome: "read", programs, fileEffects, unresolved: parts } });
const unreadShell = (command: string, why: string, cause?: "too-complex"): Effect => effect({ kind: "execute", command, reading: { outcome: "unread", why, ...(cause === undefined ? {} : { cause }) } });
const writes = (path: string, change = "modify", existenceUnknown = false) => ({ effect: { kind: "write", path, change }, ...(existenceUnknown ? { existenceUnknown: true } : {}) });

describe("PrerequisiteRule — before an execute, and shell writes (ADR 2026-019, amended)", () => {
  test("a rule before an execute comes before a shell command that runs its program with its words, wrapped or nested, and names what it runs, where", () => {
    const apply = rule(beforeApply);
    const direct = shell("terraform apply", [ran("terraform", ["apply"])], [], [], "infra");
    expect(apply.matchBefore(direct)).toEqual({ kind: "comes-before", what: "execute `terraform apply` in infra, which runs 'terraform apply'" });
    expect(apply.comesBefore(direct)).toBe(true);
    const wrapped = shell("sudo terraform apply", [ran("sudo", ["terraform", "apply"]), ran("terraform", ["apply"])]);
    expect(apply.matchBefore(wrapped)).toEqual({ kind: "comes-before", what: "execute `sudo terraform apply`, which runs 'terraform apply'" });
    expect(apply.comesBefore(wrapped)).toBe(true);
    expect(apply.describeBefore()).toBe("before executing 'terraform apply'");
  });

  test("a rule before an execute cannot see through an unread command, an unresolved program, argument or code, or a run passing its program, and is never before a file tool's write or a delegation", () => {
    const apply = rule(beforeApply);
    const cases: readonly (readonly [Effect, string, CannotSeeFix])[] = [
      [unreadShell("terraform apply", "bounded's shell parser could not load (x)"), "the command could not be read (bounded's shell parser could not load (x))", "reinstall"],
      [unreadShell("terraform apply", "the command is too complex", "too-complex"), "the command could not be read (the command is too complex)", "simplify"],
      [shell("$TF apply", [ran(unresolvedWord("$TF"), ["apply"])]), "it runs a program whose name only the shell can resolve ('$TF')", "readable"],
      [shell("terraform $X", [ran("terraform", [unresolvedWord("$X")])]), "'$X', which only the shell can resolve, stands before terraform's argument 'apply' could be found", "readable"],
      [shell('sh -c "$X"', [ran("sh", ["-c", unresolvedWord('"$X"')])], [], [{ text: '"$X"', role: "code" }]), "it runs code bounded cannot read ('\"$X\"')", "none"],
      [shell("echo terraform", [ran("echo", ["terraform"])]), "it passes 'terraform' to echo, which may run terraform", "none"],
    ];
    for (const [given, why, fix] of cases) {
      expect(apply.matchBefore(given)).toEqual({ kind: "cannot-see", why, fix });
      expect(apply.comesBefore(given)).toBe(false);
    }
    expect(apply.matchBefore(effect({ kind: "write", path: "infra/main.tf", change: "modify" }))).toEqual({ kind: "not-before" });
    expect(apply.matchBefore(effect({ kind: "delegate", agent: "terraform" }))).toEqual({ kind: "not-before" });
    expect(apply.matchBefore(shell("terraform plan", [ran("terraform", ["plan"])]))).toEqual({ kind: "not-before" });
  });

  test("a rule before a write comes before a shell command whose reading writes a path its pattern matches, ignoring case", () => {
    const src = rule(beforeSrc);
    expect(src.matchBefore(shell("echo x > src/a.ts", [ran("echo", ["x"])], [writes("src/a.ts")]))).toEqual({ kind: "comes-before", what: "execute `echo x > src/a.ts`, which writes 'src/a.ts'" });
    expect(src.matchBefore(shell("echo x > SRC/b.ts", [ran("echo", ["x"])], [writes("SRC/b.ts", "create", true), writes("SRC/b.ts", "modify", true)]))).toEqual({
      kind: "comes-before",
      what: "execute `echo x > SRC/b.ts`, which writes 'SRC/b.ts'",
    });
    expect(src.matchBefore(shell("rm src/c.ts", [ran("rm", ["src/c.ts"])], [writes("src/c.ts", "delete")])).kind).toBe("comes-before");
    expect(src.comesBefore(shell("rm src/c.ts", [ran("rm", ["src/c.ts"])], [writes("src/c.ts", "delete")]))).toBe(true);
    expect(src.matchBefore(shell("echo x > docs/a.md", [ran("echo", ["x"])], [writes("docs/a.md")]))).toEqual({ kind: "not-before" });
    expect(src.matchBefore(shell("cat src/a.ts", [ran("cat", ["src/a.ts"])], [{ effect: { kind: "read", path: "src/a.ts" } }]))).toEqual({ kind: "not-before" });
  });

  test("a rule before a write cannot see through an unread command, an unresolved write, code or an unresolved program name; unresolved reads, listings and directories are not writes", () => {
    const src = rule(beforeSrc);
    const cases: readonly (readonly [Effect, string, CannotSeeFix])[] = [
      [unreadShell("echo x > src/a.ts", "the parser could not load"), "the command could not be read (the parser could not load)", "reinstall"],
      [unreadShell("echo x > src/a.ts", "too complex", "too-complex"), "the command could not be read (too complex)", "simplify"],
      [shell('echo x > "$OUT"', [ran("echo", ["x"])], [], [{ text: '"$OUT"', role: "write" }]), "it writes a path only the shell can resolve ('\"$OUT\"')", "readable"],
      [shell("eval x", [ran("eval", ["x"])], [], [{ text: "x", role: "code" }]), "it runs code bounded cannot read ('x')", "none"],
      [shell("$TOOL", [ran(unresolvedWord("$TOOL"))]), "it runs a program whose name only the shell can resolve ('$TOOL')", "readable"],
    ];
    for (const [given, why, fix] of cases) {
      expect(src.matchBefore(given)).toEqual({ kind: "cannot-see", why, fix });
      expect(src.comesBefore(given)).toBe(false);
    }
    // A write part is told before code, and code before a program's name.
    const all = shell("x", [ran(unresolvedWord("$TOOL"))], [], [{ text: "y", role: "code" }, { text: "$OUT", role: "write" }]);
    expect(src.matchBefore(all)).toEqual({ kind: "cannot-see", why: "it writes a path only the shell can resolve ('$OUT')", fix: "readable" });
    for (const role of ["read", "list", "directory"]) expect(src.matchBefore(shell("x", [ran("cat", ["x"])], [], [{ text: "$X", role }]))).toEqual({ kind: "not-before" });
    // A definite write wins over what it cannot see.
    expect(src.matchBefore(shell("x", [ran(unresolvedWord("$TOOL"))], [writes("src/a.ts")], [{ text: "$OUT", role: "write" }])).kind).toBe("comes-before");
  });

  test("a write bounded cannot place in the project is one it cannot see, with its own why; the device paths are exempt", () => {
    const src = rule(beforeSrc);
    const writing = (text: string) => src.matchBefore(shell(`echo x > ${text}`, [ran("echo", ["x"])], [], [{ text, role: "write" }]));
    for (const text of ["/tmp/x", "~/x", "../x", "/dev/sda", "/dev/fd/x", "src/../../x"]) {
      expect(writing(text)).toEqual({ kind: "cannot-see", why: `it writes a path bounded cannot place in the project ('${text}')`, fix: "inside-project" });
    }
    for (const text of ['"$OUT"', "/tmp/$X", "~/`x`", "/tmp/*.log", "/tmp/a?", "/tmp/[ab]"]) {
      expect(writing(text)).toEqual({ kind: "cannot-see", why: `it writes a path only the shell can resolve ('${text}')`, fix: "readable" });
    }
    for (const text of ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd/2"]) expect({ text, match: writing(text) }).toEqual({ text, match: { kind: "not-before" } });
  });

  test("a rule before a delegation is never before a shell command, read or not", () => {
    const builder = rule(beforeBuilder);
    for (const given of [
      shell("claude -p --agent builder", [ran("claude", ["-p", "--agent", "builder"])]),
      shell("$X", [ran(unresolvedWord("$X"))], [], [{ text: "x", role: "code" }]),
      unreadShell("builder", "the parser could not load"),
    ]) {
      expect(builder.matchBefore(given)).toEqual({ kind: "not-before" });
      expect(builder.comesBefore(given)).toBe(false);
    }
  });
});
