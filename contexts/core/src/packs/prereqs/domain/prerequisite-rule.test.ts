import { describe, expect, test } from "bun:test";
import { AgentName, Effect } from "bounded/domain";
import { FileSetFingerprint } from "./file-set-fingerprint.ts";
import { PrerequisiteRecord } from "./prerequisite-record.ts";
import { PrerequisiteRule } from "./prerequisite-rule.ts";

// Three of the canonical rules; the fourth comes before an execute, which is not matched yet.
const beforeBuilder = { before: { delegate: "builder" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan" };
const beforeSrc = { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" };
const beforeTests = { before: { delegate: "test-writer" }, require: { delegate: "spec-reviewer", succeeded: true }, unchangedSince: ["spec.md", "src/**/*.contract.ts"], redirect: "Have spec-reviewer review the current spec and contracts" };

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
  test("the three canonical rules parse, and their wire form is what was written", () => {
    for (const raw of [beforeBuilder, beforeSrc, beforeTests]) {
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

  test("a rule's before names one action", () => {
    const one = "A rule's before names one action: { delegate: <agent> } or { write: <pattern> } (execute is not matched yet)";
    expect(error({ ...beforeSrc, before: {} })).toBe(one);
    expect(error({ ...beforeSrc, before: { delegate: "builder", write: "src/**" } })).toBe(one);
    expect(error({ ...beforeSrc, before: { execute: "terraform apply" } })).toBe(one);
    expect(error({ ...beforeSrc, before: "src/**" })).toBe(one);
    expect(error({ ...beforeSrc, before: { delegate: " " } })).toStartWith("A rule's before.delegate: ");
    expect(error({ ...beforeSrc, before: { write: "../x" } })).toContain("A rule's before.write pattern '../x' uses '..'");
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
    expect(rule(beforeSrc).comesBefore(effect({ kind: "execute", command: "echo x > src/a.ts" }))).toBe(false);
    expect(rule(beforeSrc).describeBefore()).toBe("before write 'src/**'");
    expect(rule(beforeBuilder).describeBefore()).toBe("before delegating to 'builder'");
  });

  test("a rule's requirement is met by a delegation to its required agent", () => {
    expect(rule(beforeSrc).requiresDelegationTo(agent("plan-reviewer"))).toBe(true);
    expect(rule(beforeSrc).requiresDelegationTo(agent("PLAN-REVIEWER"))).toBe(true);
    expect(rule(beforeSrc).requiresDelegationTo(agent("spec-reviewer"))).toBe(false);
    expect(rule(beforeSrc).requirementKey()).toBe(rule(beforeBuilder).requirementKey());
    expect(rule(beforeSrc).requirementKey()).not.toBe(rule(beforeTests).requirementKey());
  });

  test("a rule holds, is stale or is missing against records and the current fingerprint", () => {
    const plan = [".agent-state/*/plan.md"];
    const now = fingerprint("a");
    expect(rule(beforeSrc).status([], now)).toBe("missing");
    expect(rule(beforeSrc).status([record("spec-reviewer", plan, "a"), record("plan-reviewer", ["other.md"], "a")], now)).toBe("missing");
    expect(rule(beforeSrc).status([record("plan-reviewer", plan, "b")], now)).toBe("stale");
    expect(rule(beforeSrc).status([record("plan-reviewer", plan, "b"), record("Plan-Reviewer", plan, "a")], now)).toBe("holds");
    // Files back as they were reviewed: an older record holds again.
    expect(rule(beforeSrc).status([record("plan-reviewer", plan, "a"), record("plan-reviewer", plan, "b")], now)).toBe("holds");
    // Patterns that match no file are never satisfied.
    expect(rule(beforeSrc).status([record("plan-reviewer", plan, "a")], fingerprint("a", 0))).toBe("missing");
  });
});
