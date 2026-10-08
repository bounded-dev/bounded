import { describe, expect, test } from "bun:test";
import { Composition } from "../composition/composition.ts";
import type { BasePack } from "../packs/pack.contract.ts";
import { contribution, definePack } from "../packs/pack.ts";
import { corePack } from "./core-pack.ts";

const untypedPack = definePack as unknown as (spec: object) => BasePack;

describe("corePack — the core's own pack", () => {
  test("is bounded/core, depends on nothing, and declares exactly its contract's points", () => {
    expect(corePack.id.value).toBe("bounded/core");
    expect(corePack.dependsOn).toEqual([]);
    expect(Object.keys(corePack.points).sort()).toEqual([
      "delegateGuards",
      "executeGuards",
      "fetchGuards",
      "invokeGuards",
      "listGuards",
      "onProjectOpen",
      "readGuards",
      "sessionStartGuards",
      "toolUseGuards",
      "watchedPaths",
      "writeGuards",
    ]);
  });

  test("its points are frozen, owned by it, with ids under bounded/core", () => {
    expect(Object.isFrozen(corePack)).toBe(true);
    expect(Object.isFrozen(corePack.points)).toBe(true);
    for (const [key, point] of Object.entries(corePack.points)) {
      expect(point.owner).toBe(corePack);
      expect(point.id).toBe(`bounded/core.${key}`);
      expect(Object.isFrozen(point)).toBe(true);
    }
  });

  test("every function point's check refuses a value that is not a function, naming the pack and the point", () => {
    for (const [key, target] of Object.entries(corePack.points).filter(([key]) => key !== "watchedPaths")) {
      const bad = untypedPack({ id: "test-packs/bad", dependsOn: [corePack], contributes: [contribution(target as never, ["not a function" as never])] });
      expect(Composition.compose([bad, corePack], [bad, corePack])).toEqual({
        ok: false,
        error: `Pack 'test-packs/bad' contributes an invalid value to extension point 'bounded/core.${key}': a guard is a function. Fix the value, or remove the contribution`,
      });
    }
  });
});
