// The legitimate forms of prerequisite rules. Compiles without errors.
import { contribution, corePack, defineConfig } from "bounded/domain";
import { type PrerequisiteRuleJSON, prereqs } from "bounded/prereqs";

// A rule is written as its wire form, an object literal; the point's check makes the PrerequisiteRule.
const beforeTests: PrerequisiteRuleJSON = { before: { delegate: "test-writer" }, require: { delegate: "spec-reviewer", succeeded: true }, unchangedSince: ["spec.md", "src/**/*.contract.ts"], redirect: "Have spec-reviewer review the current spec and contracts" };

export default defineConfig({
  packs: [corePack, prereqs],
  contributes: [
    contribution(prereqs.points.rules, [
      { before: { delegate: "builder" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan" },
      { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" },
      beforeTests,
    ]),
  ],
});
