import type { ShellSnapshots, Snapshot } from "./watch-shell.contract.ts";

/** Snapshots in memory: a test double of ShellSnapshots, for tests only (ADR 2026-017). */
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
