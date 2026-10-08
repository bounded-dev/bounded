import { join } from "node:path";
import type { GuardLog, ProjectGuardLogs } from "bounded/application";
import { FileSystemGuardLog } from "../guard-log/guard-log.ts";

/** Each project's decisions in `<root>/.bounded/guard-log.jsonl`. */
export class FileSystemProjectGuardLogs implements ProjectGuardLogs {
  forProject(projectRoot: string): GuardLog {
    return new FileSystemGuardLog(join(projectRoot, ".bounded", "guard-log.jsonl"));
  }
}
