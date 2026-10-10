import { describe, expect, test } from "bun:test";
import { DecisionTime } from "bounded/domain";
import { PrerequisiteStatusSnapshot } from "../../domain/prerequisite-status-snapshot.ts";
import type { PrerequisiteStatusSnapshots } from "./check-prerequisites.contract.ts";

const KEY = JSON.stringify(["plan-reviewer", [".agent-state/*/plan.md"]]);

/** A read snapshot whose reading began at `readingStartedAt`, the plan-reviewer requirement holding or not; a test failure when it is not one. */
export function snapshotAt(readingStartedAt: string, holds = true): PrerequisiteStatusSnapshot {
  const parsed = PrerequisiteStatusSnapshot.parse({
    format: "bounded-prereqs-status/1",
    outcome: "read",
    readingStartedAt,
    requirements: [{ key: KEY, requiredAgent: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], status: holds ? "holds" : "stale", filesMatched: 1, pendingRun: null }],
    rules: [{ contributedBy: "bounded/project", before: { write: "src/**" }, requirementKey: KEY, allows: holds }],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** A store to test, the project root it was opened for, how to read what it keeps, and how to make its saves fail. */
export interface PrerequisiteStatusSnapshotsFixture {
  readonly snapshots: PrerequisiteStatusSnapshots;
  readonly projectRoot: string;
  /** The snapshot kept, in its file form, as another process would read it; undefined when none is. */
  kept(): Promise<unknown>;
  /** Makes every later save fail. */
  failSaves(): Promise<void>;
}

/**
 * The behaviour every PrerequisiteStatusSnapshots must have: a saved snapshot
 * is kept, in its file form (the snapshot and the project's root); an older
 * reading never replaces a newer one; a save that fails rejects and leaves no
 * snapshot kept; now() is a time as the store keeps it.
 */
export function prerequisiteStatusSnapshotsConformance(name: string, fixture: () => Promise<PrerequisiteStatusSnapshotsFixture>): void {
  describe(`${name} conforms to PrerequisiteStatusSnapshots`, () => {
    test("a new store keeps no snapshot", async () => {
      expect(await (await fixture()).kept()).toBeUndefined();
    });

    test("a saved snapshot is kept", async () => {
      const { snapshots, projectRoot, kept } = await fixture();
      const snapshot = snapshotAt("2026-10-10T12:00:00.000Z");
      await snapshots.save(snapshot);
      expect(await kept()).toEqual({ ...snapshot.toJSON(), projectRoot });
      const later = snapshotAt("2026-10-10T12:00:01.000Z", false);
      await snapshots.save(later);
      expect(await kept()).toEqual({ ...later.toJSON(), projectRoot });
    });

    test("a newer reading is kept over an older one saved after it", async () => {
      const { snapshots, projectRoot, kept } = await fixture();
      const newer = snapshotAt("2026-10-10T12:00:05.000Z");
      await snapshots.save(newer);
      await snapshots.save(snapshotAt("2026-10-10T12:00:01.000Z", false));
      expect(await kept()).toEqual({ ...newer.toJSON(), projectRoot });
    });

    test("a failed save leaves no snapshot kept", async () => {
      const { snapshots, kept, failSaves } = await fixture();
      await snapshots.save(snapshotAt("2026-10-10T12:00:00.000Z"));
      await failSaves();
      await expect(snapshots.save(snapshotAt("2026-10-10T12:00:01.000Z"))).rejects.toThrow();
      expect(await kept()).toBeUndefined();
    });

    test("now() is a time as the store keeps it", async () => {
      expect(DecisionTime.parse((await fixture()).snapshots.now()).ok).toBe(true);
    });
  });
}
