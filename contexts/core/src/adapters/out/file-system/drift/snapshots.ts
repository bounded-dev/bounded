import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShellSnapshots, WatchedHashes } from "bounded/application";

/**
 * Snapshots in `<root>/.bounded/snapshots/`, one file per call (named by a
 * hash of the call id), readable by its owner only. Hooks that run as
 * separate processes share them.
 */
export class FileSystemShellSnapshots implements ShellSnapshots {
  constructor(private readonly root: string) {}

  private file(callId: string): string {
    return join(this.root, ".bounded", "snapshots", `${createHash("sha256").update(callId).digest("hex")}.json`);
  }

  async save(callId: string, hashes: WatchedHashes): Promise<void> {
    await mkdir(join(this.root, ".bounded", "snapshots"), { recursive: true });
    await writeFile(this.file(callId), JSON.stringify(hashes), { encoding: "utf8", mode: 0o600 });
  }

  async take(callId: string): Promise<WatchedHashes | undefined> {
    let text: string;
    try {
      text = await readFile(this.file(callId), "utf8");
    } catch {
      return undefined;
    }
    await rm(this.file(callId), { force: true });
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`the snapshot for call ${callId} is not a snapshot`);
    return parsed as WatchedHashes;
  }
}
