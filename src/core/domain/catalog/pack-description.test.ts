import { describe, expect, test } from "bun:test";
import { corePack } from "../core-pack/core.pack.ts";
import { portKeysFor } from "../lifecycle/port-key.ts";
import { contribution, definePack, point } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import { Verdict } from "../verdicts/verdict.ts";
import { PackDescription } from "./pack-description.ts";

const packId = packIdsFor("test-packs");
const watcherId = packId("watcher");
const text = (raw: unknown): Result<string> => (typeof raw === "string" ? { ok: true, value: raw } : { ok: false, error: "not text" });
const noteStore = portKeysFor(watcherId)<{ save(text: string): Promise<void> }>("noteStore");
const watcher = definePack({
  id: watcherId,
  dependsOn: [corePack],
  points: { notes: point({ description: "Notes a project keeps", check: text }) },
  contributes: [
    contribution(corePack.points.beforeTool, [async () => Verdict.allow]),
    contribution(corePack.points.effectGuards.read, [() => Verdict.allow]),
    contribution(corePack.points.beforeTool, [async () => Verdict.allow]),
  ],
  ports: { noteStore },
});

describe("PackDescription — what a pack object says about itself", () => {
  test("a pack's id, its dependencies' ids, the points it contributes to (each once, in contribution order), its points and its ports", () => {
    const description = PackDescription.of(watcher);
    expect(description.id).toBe("test-packs/watcher");
    expect(description.dependsOn).toEqual(["bounded/core"]);
    expect(description.contributesTo).toEqual(["bounded/core.beforeTool", "bounded/core.effectGuards.read"]);
    expect(description.points).toEqual([{ key: "notes", id: "test-packs/watcher.notes", description: "Notes a project keeps" }]);
    expect(description.ports).toEqual([{ key: "noteStore", id: "test-packs/watcher#noteStore" }]);
    expect(Object.isFrozen(description)).toBe(true);
  });

  test("of(corePack) keys a group's members as <group>.<member>", () => {
    const description = PackDescription.of(corePack);
    expect(description.points.map(({ key }) => key)).toContain("effectGuards.read");
    expect(description.points.find(({ key }) => key === "effectGuards.read")?.id).toBe("bounded/core.effectGuards.read");
    expect(description.dependsOn).toEqual([]);
    expect(description.contributesTo).toEqual([]);
  });

  test("a pack's optional ports are described apart from its required ones, in its optionalPorts section's order", () => {
    const status = portKeysFor(watcherId)<{ save(text: string): Promise<void> }>("statusSnapshots");
    const withOptional = definePack({ id: watcherId, dependsOn: [corePack], ports: { noteStore }, optionalPorts: { statusSnapshots: status } });
    const description = PackDescription.of(withOptional);
    expect(description.ports).toEqual([{ key: "noteStore", id: "test-packs/watcher#noteStore" }]);
    expect(description.optionalPorts).toEqual([{ key: "statusSnapshots", id: "test-packs/watcher#statusSnapshots" }]);
    expect(PackDescription.of(watcher).optionalPorts).toEqual([]);
  });
});
