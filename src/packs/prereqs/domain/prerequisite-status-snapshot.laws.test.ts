import { valueObjectLaws } from "../../../core/domain/shared/value-object.laws.test-support.ts";
import { PrerequisiteStatusSnapshot } from "./prerequisite-status-snapshot.ts";

const key = JSON.stringify(["plan-reviewer", [".agent-state/*/plan.md"]]);
const requirement = { key, requiredAgent: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], status: "holds", filesMatched: 1, pendingRun: null };
const rule = { contributedBy: "bounded/project", before: { write: "src/**" }, requirementKey: key, allows: true };
const read = { format: "bounded-prereqs-status/1", outcome: "read", readingStartedAt: "2026-10-08T14:02:11.000Z", requirements: [requirement], rules: [rule] };
const unread = { format: "bounded-prereqs-status/1", outcome: "unread", readingStartedAt: "2026-10-08T14:02:11.000Z", why: "bounded/prereqs.rules: the records are locked" };
valueObjectLaws(
  "PrerequisiteStatusSnapshot",
  PrerequisiteStatusSnapshot,
  [read, unread, { ...read, requirements: [{ ...requirement, status: "missing", filesMatched: 0 }], rules: [{ ...rule, allows: false }] }],
  [{}, { ...read, format: "x" }, { ...unread, why: "" }, { ...read, projectRoot: "/work" }, { ...read, rules: [{ ...rule, requirementKey: "x" }] }],
);
