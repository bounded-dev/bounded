import { contribution, corePack, definePack } from "bounded/domain";
import { fileSetFingerprintsPort, prerequisiteRecordsPort, prerequisiteStatusSnapshotsPort } from "./application/check-prerequisites/check-prerequisites.contract.ts";
import { checkBeforeTool, recordAfterTool, recordRunAtFinish, writeStatusAfterTool, writeStatusAtFinish } from "./application/check-prerequisites/check-prerequisites.lifecycle.ts";
import { prereqsId } from "./domain/prereqs-id.ts";
import { rulesPoint } from "./domain/prerequisite-rule.ts";
import type { Prereqs } from "./prereqs.contract.ts";

/**
 * The prerequisites pack, `bounded/prereqs`: an ordinary pack (ADR 2026-019).
 * Projects contribute rules to `rules`: before an action (a delegation to an
 * agent, or a write a pattern matches), a delegation to another agent must
 * have succeeded over files that have not changed since. Its checks around
 * tool calls refuse an action whose prerequisite does not hold, and record a
 * delegation the host says finished, as the required agent, that succeeded,
 * over files unchanged while it ran; a run whose finish the host reports
 * later is recorded at that finish (ADR 2026-025). After each call and each
 * finish, a host that provides the optional status snapshot port gets the
 * status of every rule saved for display (ADR 2026-026). The agent never
 * claims anything; the harness observes. What a host must provide is its
 * ports section; what it may provide, its optionalPorts section.
 */
export const prereqs: Prereqs = definePack({
  id: prereqsId,
  dependsOn: [corePack],
  points: { rules: rulesPoint },
  contributes: [
    contribution(corePack.points.beforeTool, [checkBeforeTool]),
    contribution(corePack.points.afterTool, [recordAfterTool, writeStatusAfterTool]),
    contribution(corePack.points.onAgentRunFinish, [recordRunAtFinish, writeStatusAtFinish]),
  ],
  ports: { fileSetFingerprints: fileSetFingerprintsPort, prerequisiteRecords: prerequisiteRecordsPort },
  optionalPorts: { prerequisiteStatusSnapshots: prerequisiteStatusSnapshotsPort },
});
