import { describe, expect, test } from "bun:test";
import { PrerequisiteStart } from "./prerequisite-start.ts";

const fingerprint = { sha256: "a".repeat(64), fileCount: 1 };
const start = { delegate: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], fingerprint };
const parsed = (raw: unknown): PrerequisiteStart => {
  const result = PrerequisiteStart.parse(raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const error = (raw: unknown): string => {
  const result = PrerequisiteStart.parse(raw);
  return result.ok ? "accepted" : result.error;
};

describe("PrerequisiteStart — a delegation's files, fingerprinted as the run starts", () => {
  test("a start names the agent, its files and their fingerprint before the run", () => {
    const made = parsed({ ...start, unchangedSince: ["./spec.md", "src/**/*.contract.ts"] });
    expect(made.delegate.value).toBe("plan-reviewer");
    expect(made.unchangedSince).toEqual(["spec.md", "src/**/*.contract.ts"]);
    expect(made.fingerprint.toJSON()).toEqual(fingerprint);
    expect(made.toJSON()).toEqual({ delegate: "plan-reviewer", unchangedSince: ["spec.md", "src/**/*.contract.ts"], fingerprint });
    expect(Object.isFrozen(made) && Object.isFrozen(made.unchangedSince)).toBe(true);
  });

  test("each refusal names its field", () => {
    for (const raw of [null, [], { ...start, callId: "c1" }, { delegate: "a", unchangedSince: ["x"] }]) expect(error(raw)).toBe("A prerequisite start is { delegate, unchangedSince, fingerprint }");
    expect(error({ ...start, delegate: " " })).toStartWith("A prerequisite start's delegate: ");
    expect(error({ ...start, unchangedSince: [] })).toBe("A prerequisite start's unchangedSince is a non-empty list of file patterns");
    expect(error({ ...start, unchangedSince: "spec.md" })).toBe("A prerequisite start's unchangedSince is a non-empty list of file patterns");
    expect(error({ ...start, unchangedSince: ["/etc/passwd"] })).toStartWith("A prerequisite start's unchangedSince: A rule's unchangedSince pattern '/etc/passwd' is absolute");
    expect(error({ ...start, fingerprint: { sha256: "x", fileCount: 1 } })).toBe("A prerequisite start's fingerprint: A file-set fingerprint's sha256 is a SHA-256 in lowercase hex");
  });

  test("the same agent, by its exact name, and patterns, in any order, share a requirement key", () => {
    const one = parsed({ ...start, unchangedSince: ["spec.md", "src/**"] });
    expect(parsed({ ...start, unchangedSince: ["src/**", "spec.md"] }).requirementKey()).toBe(one.requirementKey());
    expect(parsed({ ...start, unchangedSince: ["src/**", "spec.md", "spec.md"] }).requirementKey()).toBe(one.requirementKey());
    expect(parsed({ ...start, delegate: "Plan-Reviewer", unchangedSince: ["spec.md", "src/**"] }).requirementKey()).not.toBe(one.requirementKey());
    expect(parsed({ ...start, delegate: "spec-reviewer", unchangedSince: ["spec.md", "src/**"] }).requirementKey()).not.toBe(one.requirementKey());
    expect(parsed({ ...start, unchangedSince: ["spec.md"] }).requirementKey()).not.toBe(one.requirementKey());
  });

  test("a list of starts, as kept between a call and its result, is parsed whole or refused", () => {
    const list = PrerequisiteStart.parseList([start, { ...start, delegate: "spec-reviewer" }]);
    expect(list.ok && list.value.map((made) => made.delegate.value)).toEqual(["plan-reviewer", "spec-reviewer"]);
    expect(PrerequisiteStart.parseList({ start })).toEqual({ ok: false, error: "The starts kept for a call are a list of prerequisite starts" });
    expect(PrerequisiteStart.parseList([start, { ...start, fingerprint: null }]).ok).toBe(false);
  });
});
