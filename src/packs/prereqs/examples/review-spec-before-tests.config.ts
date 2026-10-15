import { contribution, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
import { protectedPathsPack } from "bounded/protected-paths";

/**
 * Review the spec and contracts before writing tests
 *
 * For a spec-first workflow: tests are written only against a spec and
 * contracts a reviewer agent has approved.
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
        before: { delegate: "test-writer" },
        require: { delegate: "spec-reviewer", succeeded: true },
        unchangedSince: ["spec.md", "src/**/*.contract.ts"],
        redirect: "Have spec-reviewer review the current spec and contracts",
      },
    ]),
  ],
});
