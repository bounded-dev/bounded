import { contribution, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
import { protectedPathsPack } from "bounded/protected-paths";

/**
 * Review infrastructure changes before applying them
 *
 * For a project whose agents run Terraform: changes to the
 * infrastructure are applied only once a reviewer agent has approved the
 * current `infra/` files.
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
        before: { execute: "terraform apply" },
        require: { delegate: "infra-reviewer", succeeded: true },
        unchangedSince: ["infra/**"],
        redirect: "Have infra-reviewer review the current infra/ changes",
      },
    ]),
  ],
});
