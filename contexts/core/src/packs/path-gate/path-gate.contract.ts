import type { BasePack, ExtensionPoint, PackId } from "bounded/domain";
import type { ProtectedPath } from "./protected-path.contract.ts";

// The path gate, `bounded/path-gate`: every way a pack or project plugs into
// it. pathGate is typed by this contract, so its definition must match.

/** The path gate's id. */
export type PathGateId = PackId<"bounded/path-gate">;

/** The path gate's points (a type, not an interface, so it is a record of points as composition reads packs). */
export type PathGatePoints = {
  /** Deny-only path rules: what no agent may read, list, create, modify or delete, and what to do instead. */
  readonly protectedPaths: ExtensionPoint<ProtectedPath, PathGateId>;
};

/** The path gate pack: its id and its points. */
export interface PathGate extends BasePack {
  readonly id: PathGateId;
  readonly points: PathGatePoints;
}
