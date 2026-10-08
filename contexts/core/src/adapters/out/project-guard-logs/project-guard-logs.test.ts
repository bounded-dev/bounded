import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectGuardLogsConformance } from "../../../application/project-config/open-project/open-project.project-guard-logs.test-support.ts";
import { FileSystemProjectGuardLogs } from "./project-guard-logs.ts";

projectGuardLogsConformance("FileSystemProjectGuardLogs", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-project-"));
  return {
    logs: new FileSystemProjectGuardLogs(),
    root,
    recorded: async () =>
      readFileSync(join(root, ".bounded", "guard-log.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line)),
  };
});
