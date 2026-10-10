import type { PrerequisiteStatusSnapshot, PrerequisiteStatusSnapshots } from "./check-prerequisites.contract.ts";

/** A value as another process would read it back: its JSON, parsed. */
const stored = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** The status snapshot in memory: a test double of PrerequisiteStatusSnapshots, for tests only (ADR 2026-017). */
export class InMemoryPrerequisiteStatusSnapshots implements PrerequisiteStatusSnapshots {
  /** The snapshot kept, in its file form as stored; undefined when none is. */
  kept: unknown;
  /** Every snapshot given to save, in order, kept or not. */
  readonly saved: PrerequisiteStatusSnapshot[] = [];
  /** What now() gives: a time as the store keeps it, or anything a test sets. */
  time: unknown = "2026-10-10T12:00:00.000Z";
  /** When set, now() throws it. */
  nowFailure: string | undefined;
  /** Called as now() is, before it answers: a test sees what has happened by then. */
  onNow: (() => void) | undefined;
  /** When set, save rejects with it, removing the kept snapshot first. */
  saveFailure: string | undefined;
  /** When true, save never settles. */
  saveHangs = false;

  constructor(readonly projectRoot = "/work/project") {}

  now(): unknown {
    this.onNow?.();
    if (this.nowFailure !== undefined) throw new Error(this.nowFailure);
    return this.time;
  }

  async save(snapshot: PrerequisiteStatusSnapshot): Promise<void> {
    this.saved.push(snapshot);
    if (this.saveHangs) return new Promise<void>(() => {});
    if (this.saveFailure !== undefined) {
      this.kept = undefined;
      this.keptStartedAt = undefined;
      throw new Error(this.saveFailure);
    }
    // An older reading never replaces a newer one.
    if (this.keptStartedAt !== undefined && Date.parse(this.keptStartedAt) > Date.parse(snapshot.readingStartedAt.value)) return;
    this.kept = stored({ ...snapshot.toJSON(), projectRoot: this.projectRoot });
    this.keptStartedAt = snapshot.readingStartedAt.value;
  }

  /** When the kept snapshot's reading began. */
  private keptStartedAt: string | undefined;
}
