import { definePack } from "../packs/pack.ts";
import type { CorePack } from "./core.contract.ts";
import { afterToolPoint, beforeToolPoint, coreId, effectGuardsPoint, onAgentRunFinishPoint, onProjectOpenPoint, sessionStartGuardsPoint, toolUseGuardsPoint } from "./guard-points.ts";

/**
 * The core's own pack, `bounded/core`: the one place the core declares
 * extension points. Whole-call guards see the tool use; effect guards see one
 * effect of their kind and the whole call; every guard is given the
 * composition, so it can read other packs' points. The lifecycle points run
 * asynchronous work when a project opens, around each tool call, and when a
 * delegated agent run finishes. A pack that contributes to them depends on
 * this pack.
 */
export const corePack: CorePack = definePack({
  id: coreId,
  points: {
    toolUseGuards: toolUseGuardsPoint,
    sessionStartGuards: sessionStartGuardsPoint,
    effectGuards: effectGuardsPoint,
    beforeTool: beforeToolPoint,
    afterTool: afterToolPoint,
    onProjectOpen: onProjectOpenPoint,
    onAgentRunFinish: onAgentRunFinishPoint,
  },
});
