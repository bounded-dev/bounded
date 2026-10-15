import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ExampleScenarios } from "./example-scenarios.ts";

const readAllowed = { toolUse: { tool: "read", effects: [{ kind: "read", path: "README.md" }] }, verdict: { kind: "allow" } };
const one = { scenarios: [{ title: "A read is allowed", steps: [readAllowed] }] };
const two = {
  scenarios: [
    { title: "A read is allowed", projectFiles: { "README.md": "Read me.\n" }, steps: [readAllowed] },
    {
      title: "A command runs, then a file changes",
      steps: [{ toolUse: { tool: "shell", effects: [{ kind: "execute", command: "make" }], callId: "m1" }, verdict: { kind: "refuse", reason: "Not yet", redirect: "Wait" } }, { changeFiles: { "a.txt": null } }],
    },
  ],
};

valueObjectLaws("ExampleScenarios", ExampleScenarios, [one, two], [{ scenarios: [] }, {}, { scenarios: [{ title: "No tool use", steps: [{ changeFiles: { "a.txt": "a" } }] }] }, "scenarios"]);
