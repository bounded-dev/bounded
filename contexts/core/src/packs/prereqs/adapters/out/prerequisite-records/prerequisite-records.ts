import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallId } from "bounded/domain";
import type { PrerequisiteRecord, PrerequisiteRecords, PrerequisiteStart } from "../../../application/check-prerequisites/check-prerequisites.contract.ts";

/** How long a call's starts are kept: a delegation whose result never came (the host denied it after bounded allowed it) leaves them behind. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * What ends a torn line (a write cut short) when the next append finds one: a
 * tab, which no record's JSON holds raw, then this text. A line ending so was
 * never a whole record and is skipped; ignoring it grants nothing.
 */
const TORN = "\t(torn: ignored)";

const missing =(thrown: unknown): boolean => typeof thrown === "object" && thrown !== null && "code" in thrown && thrown.code === "ENOENT";

/**
 * The pack's records and starts in the project, under `.bounded/prereqs/`,
 * where the path gate's rule for `.bounded/**` keeps agents off them.
 * Records are `records.jsonl`: each appended as one whole line in one write
 * to a file opened for appending. A torn last line (a write cut short) is
 * ignored when read; the next append ends it with a marker first, so it stays
 * ignored and the record starts on a line of its own. Any other malformed
 * complete line makes reading reject. Records are never compacted.
 * A call's starts are `started/calls/<sha256 of the call id>.json`, written to
 * a temporary file and renamed into place; starts older than a day are never
 * given back, and are swept away whenever starts are saved.
 */
export class FileSystemPrerequisiteRecords implements PrerequisiteRecords {
  private readonly dir: string;
  private readonly recordsFile: string;
  private readonly startsDir: string;

  constructor(root: string) {
    this.dir = join(root, ".bounded", "prereqs");
    this.recordsFile = join(this.dir, "records.jsonl");
    this.startsDir = join(this.dir, "started", "calls");
  }

  async append(record: PrerequisiteRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const handle = await open(this.recordsFile, "a+");
    try {
      const { size } = await handle.stat();
      let torn = false;
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        torn = last[0] !== 0x0a;
      }
      await handle.write(`${torn ? `${TORN}\n` : ""}${JSON.stringify(record)}\n`);
    } finally {
      await handle.close();
    }
  }

  async readAll(): Promise<readonly unknown[]> {
    let text: string;
    try {
      text = await readFile(this.recordsFile, "utf8");
    } catch (thrown) {
      if (missing(thrown)) return [];
      throw thrown;
    }
    const lines = text.split("\n");
    // The text after the last newline is a line cut short (or nothing): ignored.
    lines.pop();
    const records: unknown[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "" || line.endsWith(TORN)) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        throw new Error(`line ${index + 1} of ${this.recordsFile} is not a record`);
      }
    }
    return records;
  }

  async saveStartedForCall(callId: CallId, starts: readonly PrerequisiteStart[]): Promise<void> {
    await mkdir(this.startsDir, { recursive: true });
    await this.sweep();
    const file = this.fileFor(callId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(starts), "utf8");
    await rename(temporary, file);
  }

  async takeStartedForCall(callId: CallId): Promise<unknown> {
    const file = this.fileFor(callId);
    let text: string;
    try {
      const expired = Date.now() - (await stat(file)).mtimeMs > MAX_AGE_MS;
      text = expired ? "" : await readFile(file, "utf8");
    } catch (thrown) {
      if (missing(thrown)) return undefined;
      throw thrown;
    } finally {
      await rm(file, { force: true });
    }
    return text === "" ? undefined : JSON.parse(text);
  }

  private fileFor(callId: CallId): string {
    return join(this.startsDir, `${createHash("sha256").update(callId.value).digest("hex")}.json`);
  }

  /** Removes every call's starts older than a day, and temporary files left by a write cut short. */
  private async sweep(): Promise<void> {
    for (const name of await readdir(this.startsDir)) {
      const file = join(this.startsDir, name);
      const old = await stat(file).then(
        (found) => Date.now() - found.mtimeMs > MAX_AGE_MS,
        () => false,
      );
      if (old) await rm(file, { force: true });
    }
  }
}
