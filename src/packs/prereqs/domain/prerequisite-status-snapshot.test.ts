import { describe, expect, test } from "bun:test";
import { PrerequisiteRule } from "./prerequisite-rule.ts";
import { PrerequisiteStatusSnapshot } from "./prerequisite-status-snapshot.ts";

/** The key of the requirement a rule requiring `agent` over `patterns` needs, as the rule gives it. */
function keyOf(agent: string, patterns: readonly string[]): string {
  const rule = PrerequisiteRule.parse({ before: { delegate: "builder" }, require: { delegate: agent, succeeded: true }, unchangedSince: patterns, redirect: "Run it" });
  if (!rule.ok) throw new Error(rule.error);
  return rule.value.requirementKey();
}

const PLAN = keyOf("plan-reviewer", [".agent-state/*/plan.md"]);
const SPEC = keyOf("spec-reviewer", ["spec.md"]);
const INFRA = keyOf("infra-reviewer", ["infra/**"]);
const FORMAT = "bounded-prereqs-status/1";
const STARTED = "2026-10-08T14:02:11.000Z";

const planHolds = { key: PLAN, requiredAgent: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], status: "holds", filesMatched: 3, pendingRun: null };
const specStale = { key: SPEC, requiredAgent: "spec-reviewer", unchangedSince: ["spec.md"], status: "stale", filesMatched: 1, pendingRun: null };
const infraPending = { key: INFRA, requiredAgent: "infra-reviewer", unchangedSince: ["infra/**"], status: "pending", filesMatched: 2, pendingRun: { agentRunId: "a6eef1505a0b443a2", startedAt: "2026-10-08T14:00:00.000Z" } };
const builderRule = { contributedBy: "bounded/project", before: { delegate: "builder" }, requirementKey: PLAN, allows: true };
const srcRule = { contributedBy: "bounded/project", before: { write: "src/**" }, requirementKey: SPEC, allows: false };
const applyRule = { contributedBy: "bounded/project", before: { execute: "terraform apply" }, requirementKey: INFRA, allows: false };
const read = { format: FORMAT, outcome: "read", readingStartedAt: STARTED, requirements: [planHolds, specStale, infraPending], rules: [builderRule, srcRule, applyRule] };
const unread = { format: FORMAT, outcome: "unread", readingStartedAt: STARTED, why: "bounded/prereqs.rules: the prerequisites recorded so far could not be read: the records are locked" };

const error = (raw: unknown): string => {
  const parsed = PrerequisiteStatusSnapshot.parse(raw);
  return parsed.ok ? "accepted" : parsed.error;
};
const WHAT = "A prerequisite status snapshot";

describe("PrerequisiteStatusSnapshot — what bounded/prereqs's status is, as of a reading (ADR 2026-026)", () => {
  test("a read snapshot lists each requirement once and each rule with its before and whether the gate allows it", () => {
    const parsed = PrerequisiteStatusSnapshot.parse(read);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect<unknown>(parsed.value.toJSON()).toEqual(read);
    expect<unknown>(JSON.parse(JSON.stringify(parsed.value))).toEqual(read);
    expect(parsed.value.outcome).toBe("read");
    expect(parsed.value.readingStartedAt.value).toBe(STARTED);
    expect(Object.isFrozen(parsed.value)).toBe(true);
    const again = PrerequisiteStatusSnapshot.parse(JSON.parse(JSON.stringify(parsed.value)));
    expect(again.ok && again.value.equals(parsed.value)).toBe(true);
  });

  test("an unread snapshot says why", () => {
    const parsed = PrerequisiteStatusSnapshot.parse(unread);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect<unknown>(parsed.value.toJSON()).toEqual(unread);
    expect(parsed.value.outcome).toBe("unread");
  });

  test("a read snapshot with no rules has no requirements", () => {
    expect(error({ ...read, requirements: [], rules: [] })).toBe("accepted");
  });

  test("each field is checked, naming it", () => {
    const requirement = (changed: object) => ({ ...read, requirements: [{ ...planHolds, ...changed }, specStale, infraPending] });
    const rule = (changed: object) => ({ ...read, rules: [{ ...builderRule, ...changed }, srcRule, applyRule] });
    expect(error(requirement({ status: "done" }))).toBe(`${WHAT}'s requirement 1's status is holds, pending, stale or missing`);
    expect(error(requirement({ filesMatched: -1 }))).toBe(`${WHAT}'s requirement 1's filesMatched is a whole number, 0 or more`);
    expect(error(requirement({ filesMatched: 1.5 }))).toBe(`${WHAT}'s requirement 1's filesMatched is a whole number, 0 or more`);
    expect(error(requirement({ filesMatched: 0 }))).toBe(`${WHAT}'s requirement 1 matches no file, so its status is missing`);
    expect(error({ ...read, requirements: [planHolds, specStale, { ...infraPending, pendingRun: { agentRunId: "a1" } }] })).toBe(`${WHAT}'s requirement 3's pendingRun is null or { agentRunId, startedAt }`);
    expect(error({ ...read, requirements: [planHolds, specStale, { ...infraPending, pendingRun: { agentRunId: "a1", startedAt: "soon" } }] })).toStartWith(`${WHAT}'s requirement 3's pendingRun.startedAt: A decision time is ISO 8601 in UTC`);
    expect(error(requirement({ pendingRun: infraPending.pendingRun }))).toBe(`${WHAT}'s requirement 1 has a pendingRun exactly when its status is pending`);
    expect(error({ ...read, requirements: [planHolds, specStale, { ...infraPending, pendingRun: null }] })).toBe(`${WHAT}'s requirement 3 has a pendingRun exactly when its status is pending`);
    expect(error(requirement({ requiredAgent: " " }))).toStartWith(`${WHAT}'s requirement 1's requiredAgent: `);
    expect(error(requirement({ unchangedSince: [] }))).toStartWith(`${WHAT}'s requirement 1's unchangedSince: `);
    expect(error(requirement({ key: SPEC }))).toBe(`${WHAT}'s requirement 1's key is not the key of its requiredAgent and unchangedSince`);
    expect(error(requirement({ extra: 1 }))).toBe(`${WHAT}'s requirement 1 is { key, requiredAgent, unchangedSince, status, filesMatched, pendingRun }`);
    expect(error({ ...read, requirements: [planHolds, planHolds] , rules: [builderRule] })).toBe(`${WHAT}'s requirement 2 repeats the key of requirement 1: list each requirement once`);
    expect(error({ ...read, requirements: "x" })).toBe(`${WHAT}'s requirements are a list of requirements`);
    expect(error(rule({ requirementKey: keyOf("someone", ["x.md"]) }))).toBe(`${WHAT}'s rule 1's requirementKey names no requirement in the snapshot`);
    expect(error(rule({ before: { read: "x" } }))).toStartWith(`${WHAT}'s rule 1's before: A rule's before names one action`);
    expect(error(rule({ contributedBy: "nobody" }))).toStartWith(`${WHAT}'s rule 1's contributedBy: `);
    expect(error(rule({ allows: "yes" }))).toBe(`${WHAT}'s rule 1's allows is true or false`);
    expect(error(rule({ allows: false }))).toBe(`${WHAT}'s rule 1 allows exactly when its requirement holds`);
    expect(error(rule({ extra: 1 }))).toBe(`${WHAT}'s rule 1 is { contributedBy, before, requirementKey, allows }`);
    expect(error({ ...read, rules: {} })).toBe(`${WHAT}'s rules are a list of rules`);
    expect(error({ ...read, readingStartedAt: "now" })).toStartWith(`${WHAT}'s readingStartedAt: A decision time is ISO 8601 in UTC`);
    expect(error({ ...read, outcome: "partial" })).toBe(`${WHAT}'s outcome is "read" or "unread"`);
    expect(error({ ...unread, why: " " })).toBe(`${WHAT}'s why says why the status could not be read`);
    expect(error({ ...unread, why: 5 })).toBe(`${WHAT}'s why says why the status could not be read`);
    expect(error({ ...read, format: "bounded-prereqs-status/2" })).toBe(`${WHAT}'s format is "bounded-prereqs-status/1"`);
    expect(error({ ...read, why: "x" })).toBe(`${WHAT} is { format, outcome, readingStartedAt, requirements, rules } when read, or { format, outcome, readingStartedAt, why } when unread`);
    for (const raw of [null, [], "read", { ...unread, requirements: [] }]) {
      expect(error(raw)).toBe(`${WHAT} is { format, outcome, readingStartedAt, requirements, rules } when read, or { format, outcome, readingStartedAt, why } when unread`);
    }
  });

  test("it holds no project root: a snapshot with one is refused, as any extra key is (the file form adds it)", () => {
    const form = `${WHAT} is { format, outcome, readingStartedAt, requirements, rules } when read, or { format, outcome, readingStartedAt, why } when unread`;
    expect(error({ ...read, projectRoot: "/work/project" })).toBe(form);
    expect(error({ ...unread, projectRoot: "/work/project" })).toBe(form);
  });

  test("never throws", () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("trap"); }, get: () => { throw new Error("trap"); } });
    expect(error(hostile)).toBe(`${WHAT} could not be read: trap`);
  });
});
