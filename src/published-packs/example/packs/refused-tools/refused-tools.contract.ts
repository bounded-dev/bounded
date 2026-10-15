import type { BasePack, ExtensionPoint } from "bounded/domain";
import type { RefusedToolsId } from "./domain/refused-tools-id.contract.ts";
import type { RefusedTool } from "./domain/refused-tool.contract.ts";

export type { RefusedToolsId } from "./domain/refused-tools-id.contract.ts";

// The refused-tools pack, `bounded-example/refused-tools`: every way a pack or
// project plugs into it. refusedToolsPack is typed by this contract, so its
// definition must match.

/** The refused-tools pack's points (a type, not an interface, so it is a record of points as composition reads packs). */
export type RefusedToolsPackPoints = {
  /** The tool kinds no agent may use, each with what to do instead. */
  readonly refusedTools: ExtensionPoint<RefusedTool, RefusedToolsId>;
};

/** The refused-tools pack: its id and its points; it declares no ports. */
export interface RefusedToolsPack extends BasePack {
  readonly id: RefusedToolsId;
  readonly points: RefusedToolsPackPoints;
}
