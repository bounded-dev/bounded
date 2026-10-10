import type { BasePack } from "bounded/domain";
import type { AlphaId } from "./domain/alpha-id.ts";

/** The second demonstration pack: an id, and no points or ports. */
export interface AlphaPack extends BasePack {
  readonly id: AlphaId;
}
