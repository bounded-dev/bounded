import { valueObjectLaws } from "../../../core/domain/shared/value-object.laws.test-support.ts";
import { PrerequisiteRecord } from "./prerequisite-record.ts";

const fingerprint = { sha256: "a".repeat(64), fileCount: 1 };
valueObjectLaws(
  "PrerequisiteRecord",
  PrerequisiteRecord,
  [
    { delegate: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], fingerprint, callId: "toolu_1" },
    { delegate: "infra-reviewer", unchangedSince: ["infra/**"], fingerprint: { sha256: "c".repeat(64), fileCount: 9 }, callId: "toolu_2" },
  ],
  [{ delegate: "a", unchangedSince: ["x"], fingerprint }, { delegate: "a", unchangedSince: ["x"], fingerprint, callId: "" }, { delegate: "a", unchangedSince: [], fingerprint, callId: "c" }],
);
