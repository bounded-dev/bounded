import { describe, expect, test } from "bun:test";
import { corePack } from "../core-pack/core.pack.ts";
import { contribution, definePack, point } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import { Config, defineConfig } from "./config.ts";

const packId = packIdsFor("test-packs");
const text = (raw: unknown): Result<string> => (typeof raw === "string" ? { ok: true, value: raw } : { ok: false, error: "a word is text" });
const words = definePack({ id: packId("words"), points: { list: point({ description: "Words", check: text, values: ["alpha"] }) } });
const other = definePack({ id: packId("other"), points: { list: point({ description: "Other words", check: text }) } });
const needsWords = definePack({ id: packId("needs-words"), dependsOn: [words] });
const top = definePack({ id: packId("top"), dependsOn: [needsWords] });
/** defineConfig given untyped data, as a configuration that reaches run time without type checking is. */
const loose = (spec: object) => (defineConfig as unknown as (spec: object) => ReturnType<typeof defineConfig>)(spec);
/** The refusal of two different pack objects with one id, naming where each comes from. */
const TWIN = (id: string, first: string, second: string) =>
  `Two different packs have the id '${id}': ${first}, and ${second}. They are two copies of one package, or two packs given one id; make every pack use the same one`;

describe("defineConfig", () => {
  test("a configuration selects pack objects and adds the project's own contributions", () => {
    const config = defineConfig({ packs: [corePack, words], contributes: [contribution(words.points.list, ["beta"])] });
    const composed = config.compose();
    if (!composed.ok) throw new Error(composed.error);
    expect(composed.value.read(words.points.list)).toEqual({ ok: true, value: ["alpha", "beta"] });
    expect(composed.value.packs.map((pack) => pack.id.value)).toEqual(["bounded/core", "test-packs/words", "bounded/project"]);
  });

  test("a selection brings in every pack its listed packs depend on, transitively, and the project still comes last", () => {
    const composed = defineConfig({ packs: [corePack, top] }).compose();
    if (!composed.ok) throw new Error(composed.error);
    expect(composed.value.packs.map((pack) => pack.id.value)).toEqual(["bounded/core", "test-packs/words", "test-packs/needs-words", "test-packs/top", "bounded/project"]);
    expect(composed.value.read(words.points.list)).toEqual({ ok: true, value: ["alpha"] });
  });

  test("the project acts as a final pack that depends on every listed pack, not on the packs they bring in", () => {
    const config = defineConfig({ packs: [needsWords] });
    expect(config.projectPack.id.value).toBe("bounded/project");
    expect(config.projectPack.dependsOn).toEqual([needsWords]);
    expect(config.listedPacks).toEqual([needsWords]);
  });

  test("a project contribution to a point of a pack brought in but not listed is refused, naming the pack that brings it in and the fix", () => {
    expect(loose({ packs: [corePack, needsWords], contributes: [contribution(words.points.list, ["x"])] }).compose()).toEqual({
      ok: false,
      error: "The project contributes to extension point 'test-packs/words.list', owned by pack 'test-packs/words', which bounded.config.ts does not list in packs (it is selected only because 'test-packs/needs-words' depends on it). Add 'test-packs/words' to packs, or remove the contribution",
    });
  });

  test("a project contribution to a point of a pack it did not select is refused at composition", () => {
    expect(loose({ packs: [corePack, words], contributes: [contribution(other.points.list, ["x"])] }).compose()).toEqual({
      ok: false,
      error: "The project contributes to extension point 'test-packs/other.list', owned by pack 'test-packs/other', which bounded.config.ts does not list in packs. Add 'test-packs/other' to packs, or remove the contribution",
    });
  });

  test("a project contribution to the point of another copy of a listed pack is refused", () => {
    const wordsCopy = definePack({ id: packId("words"), points: { list: point({ description: "Copy", check: text }) } });
    expect(loose({ packs: [corePack, words], contributes: [contribution(wordsCopy.points.list, ["x"])] }).compose()).toEqual({
      ok: false,
      error: "The project contributes to extension point 'test-packs/words.list', owned by a pack with the id 'test-packs/words' that is not the one bounded.config.ts lists in packs (another pack with that id, or another copy of it). Contribute to the point of the listed pack, or remove the contribution",
    });
  });

  test("a project contribution to the point of another copy of a brought-in, unlisted pack is refused, naming the selected copy and what brings it in", () => {
    const wordsCopy = definePack({ id: packId("words"), points: { list: point({ description: "Copy", check: text }) } });
    expect(loose({ packs: [corePack, needsWords], contributes: [contribution(wordsCopy.points.list, ["x"])] }).compose()).toEqual({
      ok: false,
      error: "The project contributes to extension point 'test-packs/words.list', owned by pack 'test-packs/words', which bounded.config.ts does not list in packs (the selected 'test-packs/words' is another copy, brought in by 'test-packs/needs-words'). Add 'test-packs/words' to packs, or remove the contribution",
    });
  });

  test("the core pack need not be listed when a listed pack depends on it", () => {
    const guarding = definePack({ id: packId("guarding"), dependsOn: [corePack] });
    const composed = defineConfig({ packs: [guarding] }).compose();
    if (!composed.ok) throw new Error(composed.error);
    expect(composed.value.packs.map((pack) => pack.id.value)).toEqual(["bounded/core", "test-packs/guarding", "bounded/project"]);
  });

  test("two copies of one pack in a selection are refused, naming both", () => {
    const wordsCopy = definePack({ id: packId("words") });
    const needsCopy = definePack({ id: packId("needs-copy"), dependsOn: [wordsCopy] });
    expect(defineConfig({ packs: [corePack, words, needsCopy] }).compose()).toEqual({
      ok: false,
      error: TWIN("test-packs/words", "one listed", "one that 'test-packs/needs-copy' depends on"),
    });
  });

  test("only a configuration made by defineConfig is one", () => {
    const config = defineConfig({ packs: [corePack] });
    expect(Config.parse(config)).toEqual({ ok: true, value: config });
    expect(Config.parse(null).ok).toBe(false);
    expect(Config.parse(undefined).ok).toBe(false);
    expect(Config.parse({ ...config })).toEqual({ ok: false, error: "This is not a configuration made by defineConfig: export default defineConfig({ packs: [...] })" });
  });

  test("is frozen, and never throws on untyped input", () => {
    const config = defineConfig({ packs: [corePack] });
    expect(Object.isFrozen(config) && Array.isArray(config.listedPacks) && Object.isFrozen(config.listedPacks)).toBe(true);
    const odd = (defineConfig as unknown as (spec: unknown) => ReturnType<typeof defineConfig>)({ packs: 5 });
    expect(odd.compose()).toEqual({ ok: false, error: "A configuration's packs must be a list of packs made with definePack" });
    expect((): unknown => (defineConfig as unknown as (spec: unknown) => unknown)(null)).not.toThrow();
  });
});
