import { contribution, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
import { protectedPathsPack } from "bounded/protected-paths";

/**
 * Review the plan before building it
 *
 * Neither a delegation to the builder agent nor a write under `src/` is
 * allowed until plan-reviewer has succeeded over the current plan. Both
 * rules share one requirement, so one review meets both, and editing the
 * plan afterwards makes the review stale. The protected-paths pack keeps
 * agents off the records in `.bounded/` and off the agent definitions that
 * say who plan-reviewer is.
 */
export default defineConfig({
  packs: [protectedPathsPack, prereqs],
  contributes: [
    contribution(protectedPathsPack.points.protectedPaths, [
      { match: ".bounded/**", deny: ["create", "modify", "delete"], why: "Bounded's own state, where prereqs keeps its records", redirect: "Leave .bounded/ to Bounded" },
      { match: ".claude/agents/**", deny: ["create", "modify", "delete"], why: "the agent definitions say who each agent is", redirect: "Ask a person to change an agent's definition" },
    ]),
    contribution(prereqs.points.rules, [
      {
        before: { delegate: "builder" },
        require: { delegate: "plan-reviewer", succeeded: true },
        unchangedSince: [".agent-state/*/plan.md"],
        redirect: "Have plan-reviewer review the current plan",
      },
      {
        before: { write: "src/**" },
        require: { delegate: "plan-reviewer", succeeded: true },
        unchangedSince: [".agent-state/*/plan.md"],
        redirect: "Have plan-reviewer review the current plan before editing src/",
      },
    ]),
  ],
});
