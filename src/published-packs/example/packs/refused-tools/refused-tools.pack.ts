import { contribution, corePack, definePack } from "bounded/domain";
import { refuseListedTools } from "./application/refuse-listed-tools/refuse-listed-tools.ts";
import { refusedToolsId } from "./domain/refused-tools-id.ts";
import { refusedToolsPoint } from "./domain/refused-tool.ts";
import type { RefusedToolsPack } from "./refused-tools.contract.ts";

/**
 * The refused-tools pack, `bounded-example/refused-tools`: the pack of the
 * fixture that keeps the published-pack slot tested (ADR 2026-030). Projects
 * contribute the tool kinds no agent may use to `refusedTools`; its one guard
 * refuses every tool use of a listed kind, with the rule's redirect. It needs
 * no ports.
 */
export const refusedToolsPack: RefusedToolsPack = definePack({
  id: refusedToolsId,
  dependsOn: [corePack],
  points: { refusedTools: refusedToolsPoint },
  contributes: [contribution(corePack.points.toolUseGuards, [refuseListedTools])],
});
