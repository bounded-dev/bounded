import { describe, expect, test } from "bun:test";
import { Composition } from "../composition/composition.ts";
import type { Result } from "../shared/result.ts";
import { contribution, definePack, point, pointGroup } from "./pack.ts";
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

  test("a group's member points have the ids <pack>.<group>.<member>, are owned by the pack and frozen, and are read like any point", () => {
    const words = definePack({
      id: packId("words"),
      points: { byLanguage: pointGroup({ english: point({ description: "English words", check: text, values: ["alpha"] }), french: point({ description: "French words", check: text }) }) },
    });
    const { english, french } = words.points.byLanguage;
    expect(Object.isFrozen(words.points.byLanguage)).toBe(true);
    expect(Object.getPrototypeOf(words.points.byLanguage)).toBe(null);
    expect([english.id, french.id]).toEqual(["test-packs/words.byLanguage.english", "test-packs/words.byLanguage.french"]);
    expect(english.owner).toBe(words);
    expect(Object.isFrozen(english)).toBe(true);
    const user = definePack({ id: packId("user"), dependsOn: [words], contributes: [contribution(french, ["bonjour"])] });
    const composed = Composition.compose([words, user], [words, user]);
    expect(composed.ok && composed.value.read(english)).toEqual({ ok: true, value: ["alpha"] });
    expect(composed.ok && composed.value.read(french)).toEqual({ ok: true, value: ["bonjour"] });
  });
});
