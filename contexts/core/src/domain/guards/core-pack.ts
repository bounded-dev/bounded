import type { Composition } from "../composition/composition.contract.ts";
import type { DelegateEffect, Effect, ExecuteEffect, FetchEffect, InvokeEffect, ListEffect, ReadEffect, WriteEffect } from "../events/effect.contract.ts";
import type { SessionStart } from "../events/session-start.contract.ts";
import type { ToolUse } from "../events/tool-use.contract.ts";
import { WatchedPath } from "../drift/watched-path.ts";
import { definePack, point } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import type { EffectGuard, Guard } from "./guard.contract.ts";

/**
 * A check for guards: a contributed value must be a function. Its signature
 * cannot be seen at run time, so this is where a value is taken at its
 * declared type; dispatch re-checks every verdict a guard returns, so a guard
 * of the wrong shape refuses rather than allows.
 */
function guardOf<G>(raw: unknown): Result<G> {
  return typeof raw === "function" ? { ok: true, value: raw as G } : { ok: false, error: "a guard is a function" };
}
const forCall = guardOf<Guard<ToolUse, Composition>>;
const forStart = guardOf<Guard<SessionStart, Composition>>;
const forEffect = <F extends Effect>() => guardOf<EffectGuard<F, Composition>>;

/**
 * The core's own pack, `bounded/core`: the one place the core declares
 * extension points. Whole-call guards see the tool use; effect guards see one
 * effect of their kind and the whole call; every guard is given the
 * composition, so it can read other packs' points. A pack that contributes
 * guards depends on this pack.
 */
export const corePack = definePack({
  id: packIdsFor("bounded")("core"),
  points: {
    toolUseGuards: point({ description: "Guards for whole tool calls, such as allowlists of tools", check: forCall }),
    sessionStartGuards: point({ description: "Guards for session starts", check: forStart }),
    readGuards: point({ description: "Guards for reading a file's contents", check: forEffect<ReadEffect>() }),
    listGuards: point({ description: "Guards for listing names under a directory", check: forEffect<ListEffect>() }),
    writeGuards: point({ description: "Guards for creating, modifying or deleting a file", check: forEffect<WriteEffect>() }),
    executeGuards: point({ description: "Guards for running a shell command", check: forEffect<ExecuteEffect>() }),
    fetchGuards: point({ description: "Guards for reaching the network", check: forEffect<FetchEffect>() }),
    delegateGuards: point({ description: "Guards for handing work to another agent", check: forEffect<DelegateEffect>() }),
    invokeGuards: point({ description: "Guards for tools whose effects the host cannot describe", check: forEffect<InvokeEffect>() }),
    watchedPaths: point({ description: "Files a shell command must not change: its changes to them are undone", check: WatchedPath.parse }),
  },
});
