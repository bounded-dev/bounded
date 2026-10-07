import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDecisionLogsConformance } from "../../../../application/projects/open-project/open-project.decision-logs.test-support.ts";
import { FileSystemProjectDecisionLogs } from "./decision-logs.ts";

projectDecisionLogsConformance("FileSystemProjectDecisionLogs", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-project-"));
  return {
    logs: new FileSystemProjectDecisionLogs(),
    root,
    recorded: async () =>
      readFileSync(join(root, ".bounded", "guard-log.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line)),
  };
});
