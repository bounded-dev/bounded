import { contribution, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
import { protectedPathsPack } from "bounded/protected-paths";

/**
 * Review infrastructure changes before applying them
 *
 * A shell command that runs `terraform apply` (with any options, through
 * `sudo`, `env` or `bash -c`) is refused until infra-reviewer has succeeded
 * over the current `infra/` files. A command whose program only the shell
 * can name (`$TF apply`) is refused as one bounded cannot see, until the
 * review holds. The protected-paths pack keeps agents off the records in
 * `.bounded/` and off the agent definitions.
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
