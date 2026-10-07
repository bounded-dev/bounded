import { describe, expect, test } from "bun:test";
import type { ShellSnapshots } from "./watch-shell.contract.ts";

/** The behaviour every ShellSnapshots must have: a snapshot is kept per call id and taken once. */
export function shellSnapshotsConformance(name: string, fixture: () => Promise<ShellSnapshots>): void {
  describe(`${name} conforms to ShellSnapshots`, () => {
    const hashes = { "generated/a.ts": { hash: "h1", rule: 0 }, "src/b.ts": { hash: "h2", rule: 1 } };

    test("gives back the snapshot saved for a call, once", async () => {
      const snapshots = await fixture();
      await snapshots.save("call/1:x", hashes);
      expect(await snapshots.take("call/1:x")).toEqual(hashes);
      expect(await snapshots.take("call/1:x")).toBeUndefined();
    });

    test("keeps each call's snapshot apart, and has none for a call it never saw", async () => {
      const snapshots = await fixture();
      await snapshots.save("a", hashes);
      await snapshots.save("b", {});
      expect(await snapshots.take("b")).toEqual({});
      expect(await snapshots.take("a")).toEqual(hashes);
      expect(await snapshots.take("never")).toBeUndefined();
    });
  });
}
