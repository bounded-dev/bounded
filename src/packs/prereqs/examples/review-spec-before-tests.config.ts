import { contribution, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
import { protectedPathsPack } from "bounded/protected-paths";

/**
 * Review the spec and contracts before writing tests
 *
 * A delegation to the test-writer agent is allowed only once spec-reviewer
 * has succeeded over the current spec and every contract file. Changing
 * the spec or a contract after the review makes it stale, so the tests are
 * always written against a reviewed spec. The protected-paths pack keeps
 * agents off the records in `.bounded/` and off the agent definitions.
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
