import { describe, expect, test } from "bun:test";
import { corePack } from "../guards/core-pack.ts";
import { contribution, definePack, point } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import { Config, defineConfig } from "./config.ts";

const packId = packIdsFor("test-packs");
const text = (raw: unknown): Result<string> => (typeof raw === "string" ? { ok: true, value: raw } : { ok: false, error: "a word is text" });
const words = definePack({ id: packId("words"), points: { list: point({ description: "Words", check: text, values: ["alpha"] }) } });
const other = definePack({ id: packId("other"), points: { list: point({ description: "Other words", check: text }) } });

describe("defineConfig", () => {
  test("a configuration selects pack objects and adds the project's own contributions", () => {
    const config = defineConfig({ packs: [corePack, words], contributes: [contribution(words.points.list, ["beta"])] });
    const composed = config.compose();
    if (!composed.ok) throw new Error(composed.error);
    expect(composed.value.read(words.points.list)).toEqual({ ok: true, value: ["alpha", "beta"] });
    expect(composed.value.packs.map((pack) => pack.id.value)).toEqual(["bounded/core", "test-packs/words", "bounded/project"]);
  });

  test("the project acts as a final pack that depends on every selected pack", () => {
    const config = defineConfig({ packs: [corePack, words] });
    expect(config.projectPack.id.value).toBe("bounded/project");
    expect(config.projectPack.dependsOn).toEqual([corePack, words]);
    expect(config.selectedPacks).toEqual([corePack, words]);
  });

  test("a project contribution to a point of a pack it did not select is refused at composition", () => {
    const loose = (defineConfig as unknown as (spec: object) => ReturnType<typeof defineConfig>)({ packs: [corePack, words], contributes: [contribution(other.points.list, ["x"])] });
    expect(loose.compose()).toEqual({
      ok: false,
      error: "Pack 'bounded/project' contributes to extension point 'test-packs/other.list', owned by pack 'test-packs/other', but does not depend on it. Add 'test-packs/other' to its dependencies, or remove the contribution",
    });
  });

  test("a selection whose packs need packs it does not list is refused at composition", () => {
    const needsWords = definePack({ id: packId("needs-words"), dependsOn: [words] });
    expect(defineConfig({ packs: [corePack, needsWords] }).compose()).toEqual({
      ok: false,
      error: "Pack 'test-packs/needs-words' depends on pack 'test-packs/words', which is not selected. Select it as well, or remove the dependency",
    });
  });

  test("only a configuration made by defineConfig is one", () => {
    const config = defineConfig({ packs: [corePack] });
    expect(Config.parse(config)).toEqual({ ok: true, value: config });
    expect(Config.parse(null).ok).toBe(false);
    expect(Config.parse({ ...config })).toEqual({ ok: false, error: "This is not a configuration made by defineConfig: export default defineConfig({ packs: [...] })" });
  });

  test("is frozen, and never throws on untyped input", () => {
    const config = defineConfig({ packs: [corePack] });
    expect(Object.isFrozen(config) && Object.isFrozen(config.selectedPacks)).toBe(true);
    const odd = (defineConfig as unknown as (spec: unknown) => ReturnType<typeof defineConfig>)({ packs: 5 });
    expect(odd.compose()).toEqual({ ok: false, error: "A configuration's packs must be a list of packs made with definePack" });
    expect((): unknown => (defineConfig as unknown as (spec: unknown) => unknown)(null)).not.toThrow();
  });
});
