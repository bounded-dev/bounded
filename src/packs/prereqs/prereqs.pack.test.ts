import { describe, expect, test } from "bun:test";
import { Composition, contribution, corePack, defineConfig } from "bounded/domain";
import { fileSetFingerprintsPort, prerequisiteRecordsPort } from "./application/check-prerequisites/check-prerequisites.contract.ts";
import { prereqs } from "./prereqs.pack.ts";

const canonical = [
  { before: { delegate: "builder" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan" },
  { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" },
  { before: { delegate: "test-writer" }, require: { delegate: "spec-reviewer", succeeded: true }, unchangedSince: ["spec.md", "src/**/*.contract.ts"], redirect: "Have spec-reviewer review the current spec and contracts" },
] as const;

describe("prereqs — the prerequisites pack's overview", () => {
  test("the pack's sections", () => {
    expect(prereqs.id.value).toBe("bounded/prereqs");
    expect(prereqs.dependsOn).toEqual([corePack]);
    expect(Object.keys(prereqs.points)).toEqual(["rules"]);
    expect(prereqs.points.rules.ownValues).toEqual([]);
    expect(prereqs.contributes.map((given) => given.point.id)).toEqual(["bounded/core.beforeTool", "bounded/core.afterTool", "bounded/core.onAgentRunFinish"]);
    expect(prereqs.ports).toEqual({ fileSetFingerprints: fileSetFingerprintsPort, prerequisiteRecords: prerequisiteRecordsPort });
    expect(prereqs.problem).toBeUndefined();
  });

  test("a project's canonical rules compose and are read back", () => {
    const composed = defineConfig({ packs: [corePack, prereqs], contributes: [contribution(prereqs.points.rules, canonical)] }).compose();
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    const rules = composed.value.entries(prereqs.points.rules);
    expect(rules.ok && rules.value.map(({ fromPackId, value }) => [fromPackId.value, value.toJSON()])).toEqual(canonical.map((rule) => ["bounded/project", rule]));
  });

  test("a rule built from untyped data is refused at composition, naming bounded/prereqs.rules, bounded/project and the problem", () => {
    const untyped: unknown[] = [{ before: { execute: "terraform apply" }, require: { delegate: "infra-reviewer", succeeded: true }, unchangedSince: ["infra/**"], redirect: "Have infra-reviewer review the current infra/ changes" }];
    const composed = defineConfig({ packs: [corePack, prereqs], contributes: [contribution(prereqs.points.rules, untyped as never)] }).compose();
    expect(composed.ok).toBe(false);
    const error = composed.ok ? "" : composed.error;
    expect(error).toContain("bounded/prereqs.rules");
    expect(error).toContain("bounded/project");
    expect(error).toContain("A rule's before names one action");
    expect(Composition.compose([corePack, prereqs], [corePack, prereqs]).ok).toBe(true);
  });
});
