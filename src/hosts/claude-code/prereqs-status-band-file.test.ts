// The prereqs status band reads bounded/prereqs's status file by hand (ADR
// 2026-027): it loads only its own files, so it cannot import bounded. These
// tests hold its parser to the file form bounded's own adapter writes and to
// the value object's refusals (ADR 2026-026), and its configuration names to
// the core's.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_CONFIG_NAMES as CORE_CONFIG_NAMES } from "bounded/adapters";
import { PrerequisiteRule, PrerequisiteStatusSnapshot } from "bounded/prereqs";
import { FileSystemPrerequisiteStatusSnapshots } from "bounded/prereqs/adapters";
import { PROJECT_CONFIG_NAMES } from "./prereqs-status-band/hooks/project-config-names.ts";
import { PREREQS_STATUS_FORMAT, readStatusFile } from "./prereqs-status-band/hooks/prereqs-status-file.ts";

const BAND_FOLDER = "node_modules/bounded/dist/hosts/claude-code/prereqs-status-band";

/** The key of the requirement a rule requiring `agent` over `patterns` needs, as bounded/prereqs gives it. */
function keyOf(agent: string, patterns: readonly string[]): string {
  const rule = PrerequisiteRule.parse({ before: { delegate: "someone-else" }, require: { delegate: agent, succeeded: true }, unchangedSince: patterns, redirect: "Run it" });
  if (!rule.ok) throw new Error(rule.error);
  return rule.value.requirementKey();
}

const PLAN = keyOf("plan-reviewer", [".agent-state/*/plan.md"]);
const SPEC = keyOf("spec-reviewer", ["spec.md", "src/**/*.contract.ts"]);
const INFRA = keyOf("infra-reviewer", ["infra/**"]);
const DOCS = keyOf("docs-reviewer", ["docs/never/*.md"]);
const STARTED = "2026-10-08T14:02:11.000Z";

const planHolds = { key: PLAN, requiredAgent: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], status: "holds", filesMatched: 3, pendingRun: null };
const specStale = { key: SPEC, requiredAgent: "spec-reviewer", unchangedSince: ["spec.md", "src/**/*.contract.ts"], status: "stale", filesMatched: 4, pendingRun: null };
const infraPending = { key: INFRA, requiredAgent: "infra-reviewer", unchangedSince: ["infra/**"], status: "pending", filesMatched: 2, pendingRun: { agentRunId: "a6eef1505a0b443a2", startedAt: "2026-10-08T14:00:00.000Z" } };
const docsMissing = { key: DOCS, requiredAgent: "docs-reviewer", unchangedSince: ["docs/never/*.md"], status: "missing", filesMatched: 0, pendingRun: null };
/** The canonical rules (prereqs.pack.test.ts): a delegation, a write, a delegation and an execute. */
const rules = [
  { contributedBy: "bounded/project", before: { delegate: "builder" }, requirementKey: PLAN, allows: true },
  { contributedBy: "bounded/project", before: { write: "src/**" }, requirementKey: PLAN, allows: true },
  { contributedBy: "bounded/project", before: { delegate: "test-writer" }, requirementKey: SPEC, allows: false },
  { contributedBy: "bounded/project", before: { execute: "terraform apply" }, requirementKey: INFRA, allows: false },
  { contributedBy: "bounded/project", before: { delegate: "publisher" }, requirementKey: DOCS, allows: false },
];
const read = { format: "bounded-prereqs-status/1", outcome: "read", readingStartedAt: STARTED, requirements: [planHolds, specStale, infraPending, docsMissing], rules };
const unread = { format: "bounded-prereqs-status/1", outcome: "unread", readingStartedAt: STARTED, why: "bounded/prereqs.rules: the prerequisites recorded so far could not be read: the records are locked" };

const refusalOf = (raw: unknown): string => {
  const reading = readStatusFile(JSON.stringify(raw));
  return reading.ok ? "accepted" : `${reading.kind}: ${reading.why}`;
};

describe("the prereqs status band's file reader", () => {
  test("every snapshot A's adapter writes, the band reads back whole (M-D)", async () => {
    for (const wire of [read, unread]) {
      const snapshot = PrerequisiteStatusSnapshot.parse(wire);
      if (!snapshot.ok) throw new Error(snapshot.error);
      const projectRoot = mkdtempSync(join(tmpdir(), "prereqs-status-band-"));
      await new FileSystemPrerequisiteStatusSnapshots(projectRoot).save(snapshot.value);
      const text = readFileSync(join(projectRoot, ".bounded", "prereqs", "status.json"), "utf8");
      const reading = readStatusFile(text);
      expect(reading).toEqual({ ok: true, value: { ...snapshot.value.toJSON(), projectRoot } });
    }
  });

  test("the band refuses each shape the value object refuses, naming the field", () => {
    const requirement = (index: number, changed: object) => ({ ...read, requirements: read.requirements.map((item, at) => (at === index ? { ...item, ...changed } : item)) });
    const rule = (index: number, changed: object) => ({ ...read, rules: read.rules.map((item, at) => (at === index ? { ...item, ...changed } : item)) });
    const samples: { wire: object; field: string }[] = [
      { wire: requirement(0, { status: "done" }), field: "status" },
      { wire: requirement(0, { filesMatched: -1 }), field: "filesMatched" },
      { wire: requirement(0, { filesMatched: 1.5 }), field: "filesMatched" },
      { wire: requirement(0, { filesMatched: 0 }), field: "filesMatched" },
      { wire: requirement(2, { pendingRun: { agentRunId: "a1" } }), field: "pendingRun" },
      { wire: requirement(0, { pendingRun: infraPending.pendingRun }), field: "pendingRun" },
      { wire: requirement(2, { pendingRun: null }), field: "pendingRun" },
      { wire: requirement(0, { key: SPEC }), field: "key" },
      { wire: rule(0, { requirementKey: keyOf("someone", ["x.md"]) }), field: "requirementKey" },
      { wire: rule(0, { before: { read: "x" } }), field: "before" },
      { wire: rule(0, { before: { delegate: "builder", write: "src/**" } }), field: "before" },
      { wire: rule(0, { allows: false }), field: "allows" },
      { wire: rule(2, { allows: true }), field: "allows" },
      { wire: { ...read, requirements: [planHolds, planHolds], rules: [rules[0]] }, field: "key" },
      { wire: { ...read, readingStartedAt: "yesterday" }, field: "readingStartedAt" },
      { wire: { ...read, outcome: "partial" }, field: "outcome" },
      { wire: { ...unread, why: " " }, field: "why" },
      { wire: { ...read, x: 1 }, field: "x" },
      { wire: { ...read, requirements: "x" }, field: "requirements" },
    ];
    for (const { wire, field } of samples) {
      expect([field, PrerequisiteStatusSnapshot.parse(wire).ok]).toEqual([field, false]);
      const refusal = refusalOf({ ...wire, projectRoot: "/p" });
      expect(refusal).toStartWith("shape: ");
      expect(refusal).toContain(field);
    }
  });

  test("a file names its project by an absolute projectRoot", () => {
    expect(refusalOf(read)).toStartWith("shape: ");
    expect(refusalOf(read)).toContain("projectRoot");
    for (const projectRoot of ["", "relative/root", 42]) {
      const refusal = refusalOf({ ...read, projectRoot });
      expect(refusal).toStartWith("shape: ");
      expect(refusal).toContain("projectRoot");
    }
    expect(refusalOf({ ...read, projectRoot: "/work/project" })).toBe("accepted");
  });

  test("the format is read before anything else (M-F)", () => {
    const reading = readStatusFile(JSON.stringify({ format: "bounded-prereqs-status/2", outcome: "read", requirements: "changed" }));
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.kind).toBe("format-mismatch");
    expect(reading.why).toContain("bounded-prereqs-status/2");
    expect(reading.why).toContain(PREREQS_STATUS_FORMAT);
    expect(reading.why).toContain(BAND_FOLDER);
    const none = readStatusFile(JSON.stringify({ outcome: "read", projectRoot: "/p" }));
    expect(none.ok).toBe(false);
    if (none.ok) return;
    expect(none.kind).toBe("format-mismatch");
    expect(none.why).toContain("no format");
    expect(PREREQS_STATUS_FORMAT).toBe("bounded-prereqs-status/1");
  });

  test("text that is not JSON, or JSON that is not an object, is malformed, saying which", () => {
    const notJson = readStatusFile("{");
    expect(notJson.ok === false && notJson.kind).toBe("malformed");
    expect(notJson.ok === false && notJson.why).toContain("not JSON");
    for (const text of ["[]", "null"]) {
      const notObject = readStatusFile(text);
      expect(notObject.ok === false && notObject.kind).toBe("malformed");
      expect(notObject.ok === false && notObject.why).toContain("not a JSON object");
    }
  });

  test("the band looks for the configuration names bounded loads", () => {
    expect([...PROJECT_CONFIG_NAMES]).toEqual([...CORE_CONFIG_NAMES]);
  });
});
