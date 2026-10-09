import type { PackId } from "bounded/domain";

/** The prerequisites pack's id, `bounded/prereqs`: declared before the pack, so the ports it owns can name it. */
export type PrereqsId = PackId<"bounded/prereqs">;
