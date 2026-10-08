import type { Composition } from "../composition/composition.contract.ts";
import type { EffectByKind, EffectKind } from "../events/effect.contract.ts";
import type { SessionStart } from "../events/session-start.contract.ts";
import type { ToolUse } from "../events/tool-use.contract.ts";
import type { WatchedPath as WatchedPathType, WatchedPathSource } from "../drift/watched-path.contract.ts";
import { WatchedPath } from "../drift/watched-path.ts";
import { definePack, point, pointGroup } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import type { CorePack, ProjectOpenHandler } from "./core-pack.contract.ts";
import type { EffectGuard, Guard } from "./dispatch.contract.ts";

/**
 * A check for function-valued points: a contributed value must be a
 * function. Its signature cannot be seen at run time, so this is the one
 * place a value is taken at its declared type (the one assertion rule R5
 * allows here); dispatch re-checks every verdict a guard returns, so a guard
 * of the wrong shape refuses rather than allows (ADR 2026-007).
 */
function functionOf<G>(raw: unknown): Result<G> {
  return typeof raw === "function" ? { ok: true, value: raw as G } : { ok: false, error: "a guard is a function" };
}
const forCall = functionOf<Guard<ToolUse, Composition>>;

/** A watched path, checked; or a source of them, which can only be checked when it is called. */
function watchedOf(raw: unknown): Result<WatchedPathType | WatchedPathSource> {
  return typeof raw === "function" ? functionOf<WatchedPathSource>(raw) : WatchedPath.parse(raw);
}
const forStart = functionOf<Guard<SessionStart, Composition>>;
const forOpening = functionOf<ProjectOpenHandler>;
/** The check for one effect kind's guards. */
const forEffect = <K extends EffectKind>(_kind: K) => functionOf<EffectGuard<EffectByKind[K], Composition>>;

/**
 * The core's own pack, `bounded/core`: the one place the core declares
 * extension points. Whole-call guards see the tool use; effect guards see one
 * effect of their kind and the whole call; every guard is given the
 * composition, so it can read other packs' points. A pack that contributes
 * guards depends on this pack.
 */
export const corePack: CorePack = definePack({
  id: packIdsFor("bounded")("core"),
  points: {
    toolUseGuards: point({ description: "Guards for whole tool calls, such as allowlists of tools", check: forCall }),
    sessionStartGuards: point({ description: "Guards for session starts", check: forStart }),
    // One point per effect kind; the CorePack annotation checks each against EffectByKind.
    effectGuards: pointGroup({
      read: point({ description: "Guards for reading a file's contents", check: forEffect("read") }),
      list: point({ description: "Guards for listing names under a directory", check: forEffect("list") }),
      write: point({ description: "Guards for creating, modifying or deleting a file", check: forEffect("write") }),
      execute: point({ description: "Guards for running a shell command", check: forEffect("execute") }),
      fetch: point({ description: "Guards for reaching the network", check: forEffect("fetch") }),
      delegate: point({ description: "Guards for handing work to another agent", check: forEffect("delegate") }),
      invoke: point({ description: "Guards for tools whose effects the host cannot describe", check: forEffect("invoke") }),
    }),
    onProjectOpen: point({ description: "What a pack does once when a project opens, before any event is judged, such as loading what its guards need", check: forOpening }),
    watchedPaths: point({ description: "Files a shell command must not change, or sources that work them out: a command's changes to them are undone", check: watchedOf }),
  },
});
