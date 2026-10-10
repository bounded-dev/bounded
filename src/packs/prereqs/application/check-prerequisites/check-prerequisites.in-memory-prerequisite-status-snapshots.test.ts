import { InMemoryPrerequisiteStatusSnapshots } from "./check-prerequisites.in-memory-prerequisite-status-snapshots.test-support.ts";
import { prerequisiteStatusSnapshotsConformance } from "./check-prerequisites.prerequisite-status-snapshots.test-support.ts";

prerequisiteStatusSnapshotsConformance("InMemoryPrerequisiteStatusSnapshots", async () => {
  const snapshots = new InMemoryPrerequisiteStatusSnapshots("/work/project");
  return {
    snapshots,
    projectRoot: "/work/project",
    kept: async () => snapshots.kept,
    failSaves: async () => {
      snapshots.saveFailure = "the disk is full";
    },
  };
});
