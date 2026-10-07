import type { ShellSnapshots, WatchedHashes } from "bounded/application";

/** Snapshots in memory: for tests, and hosts whose hooks share one process. */
export class InMemoryShellSnapshots implements ShellSnapshots {
  private readonly kept = new Map<string, WatchedHashes>();

  async save(callId: string, hashes: WatchedHashes): Promise<void> {
    this.kept.set(callId, hashes);
  }

  async take(callId: string): Promise<WatchedHashes | undefined> {
    const hashes = this.kept.get(callId);
    this.kept.delete(callId);
    return hashes;
  }
}
