import { join } from "node:path";
import type { DecisionLog, ProjectDecisionLogs } from "bounded/application";
import { FileSystemDecisionLog } from "../judging/decision-log.ts";

/** Each project's decisions in `<root>/.bounded/guard-log.jsonl`. */
export class FileSystemProjectDecisionLogs implements ProjectDecisionLogs {
  forProject(root: string): DecisionLog {
    return new FileSystemDecisionLog(join(root, ".bounded", "guard-log.jsonl"));
  }
}
