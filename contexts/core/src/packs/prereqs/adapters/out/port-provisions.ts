import { type PortProvision, Ports } from "bounded/domain";
import { fileSetFingerprintsPort, prerequisiteRecordsPort } from "../../application/check-prerequisites/check-prerequisites.contract.ts";
import { FileSystemFileSetFingerprints } from "./file-set-fingerprints/file-set-fingerprints.ts";
import { FileSystemPrerequisiteRecords } from "./prerequisite-records/prerequisite-records.ts";

/**
 * Every port bounded/prereqs uses, for a host's composition root: the
 * fingerprints of each project's files, and its records and starts in the
 * project's `.bounded/prereqs/`.
 */
export function prereqsPortProvisions(): readonly PortProvision[] {
  return Object.freeze([
    Ports.provide(fileSetFingerprintsPort, (projectRoot) => new FileSystemFileSetFingerprints(projectRoot)),
    Ports.provide(prerequisiteRecordsPort, (projectRoot) => new FileSystemPrerequisiteRecords(projectRoot)),
  ]);
}
