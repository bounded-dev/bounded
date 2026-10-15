import { describe, expect, test } from "bun:test";
import { corePack } from "bounded/domain";
import { refusedToolsPack } from "./refused-tools.pack.ts";

describe("refusedToolsPack — the refused-tools pack's overview", () => {
  test("is bounded-example/refused-tools, depending on the core, declaring refusedTools with no rules of its own", () => {
    expect(refusedToolsPack.id.value).toBe("bounded-example/refused-tools");
    expect(refusedToolsPack.dependsOn).toEqual([corePack]);
    expect(Object.keys(refusedToolsPack.points)).toEqual(["refusedTools"]);
    expect(refusedToolsPack.points.refusedTools.ownValues).toEqual([]);
  });

  test("contributes one whole-call guard, and needs no ports", () => {
    expect(refusedToolsPack.contributes.map((given) => given.point.id)).toEqual(["bounded/core.toolUseGuards"]);
    expect(refusedToolsPack.ports).toEqual({});
    expect(refusedToolsPack.problem).toBeUndefined();
  });
});
