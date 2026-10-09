import { describe, expect, test } from "bun:test";
import { Composition } from "../composition/composition.ts";
import { Effect } from "../events/effect.ts";
import type { BasePack } from "../packs/pack.contract.ts";
import { contribution, definePack } from "../packs/pack.ts";
import { corePack } from "./core.pack.ts";

const untypedPack = definePack as unknown as (spec: object) => BasePack;

describe("corePack — the core's own pack", () => {
  test("is bounded/core, depends on nothing, and declares exactly its contract's points", () => {
    expect(corePack.id.value).toBe("bounded/core");
    expect(corePack.dependsOn).toEqual([]);
    expect(Object.keys(corePack.points).sort()).toEqual(["afterTool", "beforeTool", "effectGuards", "onAgentRunFinish", "onProjectOpen", "sessionStartGuards", "toolUseGuards"]);
  });

  test("effectGuards has one point per effect kind Effect.parse accepts", () => {
    const kinds = ["read", "list", "write", "execute", "fetch", "delegate", "invoke"];
    const samples = [{ path: "a" }, { root: "a" }, { path: "a", change: "create" }, { command: "ls", reading: { outcome: "unread", why: "the parser could not load" } }, { url: "https://x.test" }, { agent: "helper" }, { name: "skill" }];
    expect(kinds.map((kind, i) => Effect.parse({ kind, ...samples[i] }).ok)).toEqual(kinds.map(() => true));
    expect(Effect.parse({ kind: "teleport" }).ok).toBe(false);
    expect(Object.keys(corePack.points.effectGuards).sort()).toEqual([...kinds].sort());
  });

  test("its points are frozen, owned by it, with ids under bounded/core", () => {
    expect(Object.isFrozen(corePack)).toBe(true);
    expect(Object.isFrozen(corePack.points)).toBe(true);
    const { effectGuards, ...single } = corePack.points;
    for (const [key, point] of [...Object.entries(single), ...Object.entries(effectGuards).map(([kind, point]) => [`effectGuards.${kind}`, point] as const)]) {
      expect(point.owner).toBe(corePack);
      expect(point.id).toBe(`bounded/core.${key}`);
      expect(Object.isFrozen(point)).toBe(true);
    }
  });

  test("every function point's check refuses a value that is not a function, naming the pack and the point", () => {
    const { effectGuards, ...rest } = corePack.points;
    const targets = [...Object.entries(rest), ...Object.entries(effectGuards).map(([kind, point]) => [`effectGuards.${kind}`, point] as const)];
    for (const [key, target] of targets) {
      const bad = untypedPack({ id: "test-packs/bad", dependsOn: [corePack], contributes: [contribution(target as never, ["not a function" as never])] });
      expect(Composition.compose([bad, corePack], [bad, corePack])).toEqual({
        ok: false,
        error: `Pack 'test-packs/bad' contributes an invalid value to extension point 'bounded/core.${key}': a guard is a function. Fix the value, or remove the contribution`,
      });
    }
  });
});
