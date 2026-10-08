import { describe, expect, test } from "bun:test";
import { Composition } from "../composition/composition.ts";
import type { Result } from "../shared/result.ts";
import { contribution, definePack, point } from "./pack.ts";
import { packIdsFor } from "./pack-id.ts";

const packId = packIdsFor("test-packs");
const text = (raw: unknown): Result<string> => (typeof raw === "string" ? { ok: true, value: raw } : { ok: false, error: "not text" });

describe("definePack, point and contribution — packs as the core makes them", () => {
  test("definePack makes a frozen pack whose points are owned by it, each with the id <pack>.<key>", () => {
    const words = definePack({ id: packId("words"), points: { words: point({ description: "Words", check: text, values: ["alpha"] }) } });
    expect(words.id.value).toBe("test-packs/words");
    expect(Object.isFrozen(words)).toBe(true);
    expect(Object.isFrozen(words.points)).toBe(true);
    expect(words.points.words.owner).toBe(words);
    expect(words.points.words.id).toBe("test-packs/words.words");
    expect(words.points.words.description).toBe("Words");
  });

  test("a point and a contribution are frozen, their values kept as lists", () => {
    const declared = point({ description: "Words", check: text, values: ["alpha"] });
    expect(Object.isFrozen(declared)).toBe(true);
    expect(declared.values).toEqual(["alpha"]);
    const words = definePack({ id: packId("words"), points: { words: declared } });
    const given = contribution(words.points.words, ["beta"]);
    expect(Object.isFrozen(given)).toBe(true);
    expect(given.values).toEqual(["beta"]);
    expect(given.point).toBe(words.points.words);
  });

  test("only what definePack made is a pack: a copy of one is refused when packs are composed", () => {
    const words = definePack({ id: packId("words"), points: { words: point({ description: "Words", check: text }) } });
    const copy = { ...words };
    const composed = Composition.compose([copy as typeof words], [copy as typeof words]);
    expect(composed.ok).toBe(false);
    expect(!composed.ok && composed.error).toContain("was not built with definePack(...), or was built by a different copy of bounded");
  });
});
