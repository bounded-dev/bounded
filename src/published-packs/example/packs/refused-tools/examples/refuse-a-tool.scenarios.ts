import { defineExampleScenarios } from "bounded/domain";

export default defineExampleScenarios({
  scenarios: [
    {
      title: "A web fetch is refused with the project's pointer to its docs; reading a file is allowed",
      steps: [
        {
          toolUse: { tool: "web", effects: [{ kind: "fetch", url: "https://example.com/docs" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded-example/refused-tools refused: bounded-example/refused-tools refuses the tool kind 'web' (a rule from bounded/project)",
            redirect: "Read the project's docs in docs/ instead; ask a person for anything they do not cover",
          },
        },
        { toolUse: { tool: "read", effects: [{ kind: "read", path: "README.md" }] }, verdict: { kind: "allow" } },
      ],
    },
  ],
});
