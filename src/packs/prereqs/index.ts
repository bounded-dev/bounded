// The prerequisites pack: an ordinary pack shipped in the `bounded` package.
// It depends only on the core's public exports; the core never imports it.
export type { Prereqs, PrereqsId, PrereqsPoints, PrereqsPorts } from "./prereqs.contract.ts";
export { prereqs } from "./prereqs.pack.ts";
export type { PrerequisiteBefore, PrerequisiteBeforeJSON, PrerequisiteRuleFactory, PrerequisiteRuleJSON, PrerequisiteStatus } from "./domain/prerequisite-rule.contract.ts";
export { PrerequisiteRule } from "./domain/prerequisite-rule.ts";
export type { FileSetFingerprintFactory } from "./domain/file-set-fingerprint.contract.ts";
export { FileSetFingerprint } from "./domain/file-set-fingerprint.ts";
export type { PrerequisiteRecordFactory } from "./domain/prerequisite-record.contract.ts";
export { PrerequisiteRecord } from "./domain/prerequisite-record.ts";
export type { PrerequisiteStartFactory } from "./domain/prerequisite-start.contract.ts";
export { PrerequisiteStart } from "./domain/prerequisite-start.ts";
export type { PendingAgentRunFactory } from "./domain/pending-agent-run.contract.ts";
export { PendingAgentRun } from "./domain/pending-agent-run.ts";
export type { CheckPrerequisites, FileSetFingerprintJSON, FileSetFingerprints, PendingAgentRunJSON, PrerequisiteRecordJSON, PrerequisiteRecords, PrerequisiteStartJSON } from "./application/check-prerequisites/check-prerequisites.contract.ts";
export { fileSetFingerprintsPort, prerequisiteRecordsPort } from "./application/check-prerequisites/check-prerequisites.contract.ts";

// Everything exported here is frozen, so code loaded later cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported) as unknown[]) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
