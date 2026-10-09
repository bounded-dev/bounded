import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunId, CallId } from "bounded/domain";
import type { PrerequisiteRecord, PrerequisiteRecords, PrerequisiteStart } from "../../../application/check-prerequisites/check-prerequisites.contract.ts";

/** How long a call's starts are kept: a delegation whose result never came (the host denied it after bounded allowed it) leaves them behind. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How long a run's starts are kept: a run whose finish never comes (stopped at its turn limit, or with TaskStop) leaves them behind (ADR 2026-025). */
const RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What ends a torn line (a write cut short) when the next append finds one: a
 * tab, which no record's JSON holds raw, then this text. A line ending so was
 * never a whole record and is skipped; ignoring it grants nothing.
 */
const TORN = "\t(torn: ignored)";

const missing =(thrown: unknown): boolean => typeof thrown === "object" && thrown !== null && "code" in thrown && thrown.code === "ENOENT";

/**
 * The pack's records and starts in the project, under `.bounded/prereqs/`,
 * where the protected-paths pack's rule for `.bounded/**` keeps agents off them.
 * Records are `records.jsonl`: each appended as one whole line in one write
 * to a file opened for appending. A torn last line (a write cut short) is
 * ignored when read; the next append ends it with a marker first, so it stays
 * ignored and the record starts on a line of its own. Any other malformed
 * complete line makes reading reject. Records are never compacted.
 * A call's starts are `started/calls/<sha256 of the call id>.json`, written to
 * a temporary file and renamed into place; starts older than a day are never
 * given back, and are swept away whenever starts are saved. A run's starts,
 * kept from its launch until its finish (ADR 2026-025), are
 * `started/runs/<sha256 of the run id>.json`, stamped with when they were
 * kept and written the same way; they are kept seven days, listed while
 * kept, and swept away whenever a run's starts are saved.
 */
export class FileSystemPrerequisiteRecords implements PrerequisiteRecords {
  private readonly dir: string;
  private readonly recordsFile: string;
  private readonly startsDir: string;
  private readonly runStartsDir: string;

  constructor(root: string) {
    this.dir = join(root, ".bounded", "prereqs");
    this.recordsFile = join(this.dir, "records.jsonl");
    this.startsDir = join(this.dir, "started", "calls");
    this.runStartsDir = join(this.dir, "started", "runs");
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
    await sweep(this.startsDir, MAX_AGE_MS);
    await writeWhole(fileIn(this.startsDir, callId.value), JSON.stringify(starts));
  }

  async takeStartedForCall(callId: CallId): Promise<unknown> {
    return take(fileIn(this.startsDir, callId.value), MAX_AGE_MS);
  }

  async saveStartedForRun(agentRunId: AgentRunId, callId: CallId, starts: readonly PrerequisiteStart[]): Promise<void> {
    await mkdir(this.runStartsDir, { recursive: true });
    await sweep(this.runStartsDir, RUN_MAX_AGE_MS);
    const pending = { agentRunId: agentRunId.value, callId: callId.value, startedAt: new Date().toISOString(), starts };
    await writeWhole(fileIn(this.runStartsDir, agentRunId.value), JSON.stringify(pending));
  }

  async takeStartedForRun(agentRunId: AgentRunId): Promise<unknown> {
    return take(fileIn(this.runStartsDir, agentRunId.value), RUN_MAX_AGE_MS);
  }

  async readStartedForRuns(): Promise<readonly unknown[]> {
    let names: string[];
    try {
      names = await readdir(this.runStartsDir);
    } catch (thrown) {
      if (missing(thrown)) return [];
      throw thrown;
    }
    const runs: unknown[] = [];
    for (const name of names.filter((given) => given.endsWith(".json")).sort()) {
      const file = join(this.runStartsDir, name);
      let text: string;
      try {
        if (Date.now() - (await stat(file)).mtimeMs > RUN_MAX_AGE_MS) continue;
        text = await readFile(file, "utf8");
      } catch (thrown) {
        // Gone between listing and reading: taken by its finish, or swept, in another process.
        if (missing(thrown)) continue;
        throw thrown;
      }
      try {
        runs.push(JSON.parse(text));
      } catch {
        throw new Error(`${file} is not a run's start`);
      }
    }
    return runs;
  }
}

/** The file for `id` in `dir`: named by its SHA-256, so any id is a safe name. */
const fileIn = (dir: string, id: string): string => join(dir, `${createHash("sha256").update(id).digest("hex")}.json`);

/** Writes `text` to a temporary file and renames it into place, so a reader sees it whole or not at all. */
async function writeWhole(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
}

/** What `file` holds, parsed, removed as given; undefined when it is missing or older than `maxAgeMs`; rejects when it cannot be read or parsed. */
async function take(file: string, maxAgeMs: number): Promise<unknown> {
  let text: string;
  try {
    const expired = Date.now() - (await stat(file)).mtimeMs > maxAgeMs;
    text = expired ? "" : await readFile(file, "utf8");
  } catch (thrown) {
    if (missing(thrown)) return undefined;
    throw thrown;
  } finally {
    await rm(file, { force: true });
  }
  return text === "" ? undefined : JSON.parse(text);
}

/** Removes every file in `dir` older than `maxAgeMs`, temporary files left by a write cut short included. */
async function sweep(dir: string, maxAgeMs: number): Promise<void> {
  for (const name of await readdir(dir)) {
    const file = join(dir, name);
    const old = await stat(file).then(
      (found) => Date.now() - found.mtimeMs > maxAgeMs,
      () => false,
    );
    if (old) await rm(file, { force: true });
  }
}
