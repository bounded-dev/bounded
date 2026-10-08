import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { AdapterRefusal } from "./adapter-refusal.ts";

valueObjectLaws(
  "AdapterRefusal",
  AdapterRefusal,
  [
    { hostToolName: "Bash", reason: "outside the project", redirect: "Stay inside", role: "builder", input: { command: "ls" } },
    { hostToolName: "Write", reason: "too late", redirect: "Try again", role: null },
  ],
  ["refused", 0],
);
