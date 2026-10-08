import { valueObjectLaws } from "../../../domain/shared/value-object.laws.test-support.ts";
import { PrerequisiteStart } from "./prerequisite-start.ts";

const fingerprint = { sha256: "a".repeat(64), fileCount: 1 };
valueObjectLaws(
  "PrerequisiteStart",
  PrerequisiteStart,
  [
    { delegate: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], fingerprint },
    { delegate: "spec-reviewer", unchangedSince: ["spec.md", "src/**/*.contract.ts"], fingerprint: { sha256: "b".repeat(64), fileCount: 4 } },
  ],
  [{ delegate: "a", unchangedSince: [], fingerprint }, { delegate: "a", unchangedSince: ["../x"], fingerprint }, { delegate: "a", unchangedSince: ["x"], fingerprint: null }],
);
