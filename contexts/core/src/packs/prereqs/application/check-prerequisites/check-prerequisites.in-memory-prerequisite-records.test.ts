import { prerequisiteRecordsConformance } from "./check-prerequisites.prerequisite-records.test-support.ts";
import { InMemoryPrerequisiteRecords } from "./check-prerequisites.in-memory-prerequisite-records.test-support.ts";

prerequisiteRecordsConformance("InMemoryPrerequisiteRecords", async () => new InMemoryPrerequisiteRecords());
