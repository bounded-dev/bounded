import type { Composition } from "../composition/composition.contract.ts";
import { corePack } from "../guards/core-pack.ts";
import type { PackId } from "../packs/pack-id.contract.ts";
import { show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import type { WatchedPath as WatchedPathType } from "./watched-path.contract.ts";
import { WatchedPath } from "./watched-path.ts";

/** A watched path, and the pack that contributed it. */
export interface Watched {
  readonly rule: WatchedPathType;
  readonly fromPackId: PackId;
}

/**
 * Every watched path of a composition, in pack order, each with the pack
 * that contributed it. A source is called with the composition and each path
 * it gives is checked; a source that throws or gives something else makes
 * the watched paths unreadable, so callers fail closed. Without the core
 * pack, nothing is watched.
 */
export function watchedPathsOf(composition: Composition): Result<readonly Watched[]> {
  if (!composition.packs.includes(corePack)) return { ok: true, value: [] };
  const entries = composition.entries(corePack.points.watchedPaths);
  if (!entries.ok) return entries;
  const out: Watched[] = [];
  for (const { fromPackId, value } of entries.value) {
    if (typeof value !== "function") {
      out.push({ rule: value, fromPackId });
      continue;
    }
    let given: unknown;
    try {
      given = value(composition);
    } catch (thrown) {
      return { ok: false, error: `the watched paths from ${fromPackId.value} cannot be read: ${show(thrown)}` };
    }
    if (!Array.isArray(given)) return { ok: false, error: `the watched paths from ${fromPackId.value} cannot be read: its source gave something that is not a list` };
    for (const raw of given) {
      const rule = WatchedPath.parse(raw);
      if (!rule.ok) return { ok: false, error: `the watched paths from ${fromPackId.value} cannot be read: ${rule.error}` };
      out.push({ rule: rule.value, fromPackId });
    }
  }
  return { ok: true, value: Object.freeze(out) };
}
