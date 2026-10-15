import { defineExampleScenarios } from "bounded/domain";

export default defineExampleScenarios({
  scenarios: [{ title: "A read is allowed", steps: [{ toolUse: { tool: "read", effects: [{ kind: "read", path: "README.md" }] }, verdict: { kind: "allow" } }] }],
});
