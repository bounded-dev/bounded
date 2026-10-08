import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShellSnapshots, Snapshot } from "bounded/application";
import { stateDirFor } from "./state-home.ts";

/** How long a snapshot is kept: a command whose result never came (the host denied it after bounded allowed it) leaves one behind. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Snapshots in the user's state directory, out of the project, so a command
 * run in the project does not reach them by a relative path:
 * `<stateHome>/bounded/<sha256 of the root>/snapshots/`, one file per call
 * (named by a hash of the call id), directories 0700 and files 0600. Anything
 * running as the same user can still change them, so the handler checks what
 * it is given. Snapshots older than a day are never given back, and are
 * swept away whenever one is saved. Hooks that run as separate processes
 * share them.
 */
export class FileSystemShellSnapshots implements ShellSnapshots {
  private readonly project: string;
  private readonly dir: string;

  constructor(
    root: string,
    private readonly stateHome: string,
  ) {
    this.project = stateDirFor(stateHome, root);
    this.dir = join(this.project, "snapshots");
  }

  private file(callId: string): string {
    return join(this.dir, `${createHash("sha256").update(callId).digest("hex")}.json`);
  }

  async save(callId: string, snapshot: Snapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const dir of [join(this.stateHome, "bounded"), this.project, this.dir]) await chmod(dir, 0o700);
    await this.sweep();
    await writeFile(this.file(callId), JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    await chmod(this.file(callId), 0o600);
  }

  async take(callId: string): Promise<unknown> {
    const file = this.file(callId);
    let text: string;
    try {
      const expired = Date.now() - (await stat(file)).mtimeMs > MAX_AGE_MS;
      text = expired ? "" : await readFile(file, "utf8");
    } catch {
      return undefined;
    } finally {
      await rm(file, { force: true });
    }
    return text === "" ? undefined : JSON.parse(text);
  }

  /** Removes every snapshot older than a day. */
  private async sweep(): Promise<void> {
    for (const name of await readdir(this.dir)) {
      const file = join(this.dir, name);
      const old = await stat(file).then(
        (found) => Date.now() - found.mtimeMs > MAX_AGE_MS,
        () => false,
      );
      if (old) await rm(file, { force: true });
    }
  }
}
