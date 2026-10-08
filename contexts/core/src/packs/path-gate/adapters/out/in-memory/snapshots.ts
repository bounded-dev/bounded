import type { ShellSnapshots, Snapshot } from "../../../application/watch-shell/watch-shell.contract.ts";

/** Snapshots in memory: for tests, and hosts whose hooks share one process. */
export class InMemoryShellSnapshots implements ShellSnapshots {
  private readonly kept = new Map<string, Snapshot>();

  async save(callId: string, snapshot: Snapshot): Promise<void> {
    this.kept.set(callId, snapshot);
  }

  async take(callId: string): Promise<unknown> {
    const snapshot = this.kept.get(callId);
    this.kept.delete(callId);
    return snapshot;
  }
}
