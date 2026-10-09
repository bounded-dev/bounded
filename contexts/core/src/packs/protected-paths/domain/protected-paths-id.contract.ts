import type { PackId } from "bounded/domain";

/** The protected-paths pack's id, `bounded/protected-paths`: declared before the pack, so the ports it owns can name it. */
export type ProtectedPathsId = PackId<"bounded/protected-paths">;
