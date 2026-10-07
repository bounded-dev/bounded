import { describe, expect, test } from "bun:test";
import { Composition } from "../composition/composition.ts";
import { corePack } from "../guards/core-pack.ts";
import { contribution, definePack } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import type { WatchedPath } from "./watched-path.contract.ts";
import { watchedPathsOf } from "./watched-paths.ts";

const packId = packIdsFor("test-packs");
const rule: WatchedPath = { match: "generated/**", why: "generated", redirect: "Change the input" };

describe("watchedPathsOf", () => {
  test("gives every watched path with the pack that contributed it, calling sources with the composition", () => {
    const fixed = definePack({ id: packId("fixed"), dependsOn: [corePack], contributes: [contribution(corePack.points.watchedPaths, [rule])] });
    const derived = definePack({
      id: packId("derived"),
      dependsOn: [corePack],
      contributes: [contribution(corePack.points.watchedPaths, [(composition) => (composition.packs.length > 0 ? [{ match: "build/**", why: "built", redirect: "Rebuild" }] : [])])],
    });
    const all = [corePack, fixed, derived];
    const composed = Composition.compose(all, all);
    if (!composed.ok) throw new Error(composed.error);
    const watched = watchedPathsOf(composed.value);
    expect<unknown>(watched).toEqual({
      ok: true,
      value: [
        { rule: { match: "build/**", except: [], why: "built", redirect: "Rebuild" }, from: "test-packs/derived" },
        { rule: { ...rule, except: [] }, from: "test-packs/fixed" },
      ],
    });
  });

  test("a source that throws, or gives something that is not a watched path, cannot be read", () => {
    const throwing = definePack({
      id: packId("throwing"),
      dependsOn: [corePack],
      contributes: [
        contribution(corePack.points.watchedPaths, [
          () => {
            throw new Error("boom");
          },
        ]),
      ],
    });
    const composed = Composition.compose([corePack, throwing], [corePack, throwing]);
    if (!composed.ok) throw new Error(composed.error);
    expect(watchedPathsOf(composed.value)).toEqual({ ok: false, error: "the watched paths from test-packs/throwing cannot be read: boom" });
    const bad = definePack({ id: packId("bad"), dependsOn: [corePack], contributes: [contribution(corePack.points.watchedPaths, [() => [{ match: "/etc", why: "x", redirect: "y" }]])] });
    const other = Composition.compose([corePack, bad], [corePack, bad]);
    if (!other.ok) throw new Error(other.error);
    const watched = watchedPathsOf(other.value);
    expect(!watched.ok && watched.error.startsWith("the watched paths from test-packs/bad cannot be read: Watched path pattern '/etc'")).toBe(true);
  });

  test("without the core pack, nothing is watched", () => {
    const composed = Composition.compose([], []);
    if (!composed.ok) throw new Error(composed.error);
    expect(watchedPathsOf(composed.value)).toEqual({ ok: true, value: [] });
  });
});
