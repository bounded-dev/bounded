import { join } from "node:path";
import type { BoundedLog, ProjectBoundedLogs } from "bounded/application";
import { FileSystemBoundedLog } from "../bounded-log/bounded-log.ts";

/** Each project's decisions in `<root>/.bounded/log.jsonl`. */
export class FileSystemProjectBoundedLogs implements ProjectBoundedLogs {
  forProject(projectRoot: string): BoundedLog {
    return new FileSystemBoundedLog(join(projectRoot, ".bounded", "log.jsonl"));
  }
}
