import type { PackId } from "bounded/domain";

/** The path gate's id, `bounded/path-gate`: declared before the pack, so the ports it owns can name it. */
export type PathGateId = PackId<"bounded/path-gate">;
