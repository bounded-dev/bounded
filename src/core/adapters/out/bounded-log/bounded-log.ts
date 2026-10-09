import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BoundedLog } from "bounded/application";
import type { Decision } from "bounded/domain";

/**
 * Decisions appended to a JSON-lines file, one JSON object per line, creating
 * the folders on the way. The composition root chooses the file, such as
 * `<project>/.bounded/log.jsonl`. A failed write rejects.
 */
export class FileSystemBoundedLog implements BoundedLog {
  constructor(private readonly file: string) {}

  async record(decision: Decision): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    // One append of one complete line: never a partial record from this writer.
    await appendFile(this.file, `${JSON.stringify(decision)}\n`, { encoding: "utf8", mode: 0o600 });
    // The mode above applies only when the file is created; an existing file is made private too.
    await chmod(this.file, 0o600);
  }
}
