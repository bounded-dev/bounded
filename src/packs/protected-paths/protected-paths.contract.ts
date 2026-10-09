import type { BasePack, ExtensionPoint, PortKey } from "bounded/domain";
import type { ShellSnapshots, WatchedFiles } from "./application/watch-shell/watch-shell.contract.ts";
import type { ProtectedPathsId } from "./domain/protected-paths-id.contract.ts";
import type { ProtectedPath } from "./domain/protected-path.contract.ts";

export type { ProtectedPathsId } from "./domain/protected-paths-id.contract.ts";

// The protected-paths pack, `bounded/protected-paths`: every way a pack or project plugs into
// it. protectedPathsPack is typed by this contract, so its definition must match.


/** The protected-paths pack's points (a type, not an interface, so it is a record of points as composition reads packs). */
export type ProtectedPathsPackPoints = {
  /** Deny-only path rules: what no agent may read, list, create, modify or delete, and what to do instead. */
  readonly protectedPaths: ExtensionPoint<ProtectedPath, ProtectedPathsId>;
};

/** The adapters the protected-paths pack needs a host to provide through openProject({ ports }). */
export type ProtectedPathsPackPorts = {
  readonly watchedFiles: PortKey<WatchedFiles, ProtectedPathsId>;
  readonly shellSnapshots: PortKey<ShellSnapshots, ProtectedPathsId>;
};

/** The protected-paths pack: its id, its points and its ports. */
export interface ProtectedPathsPack extends BasePack {
  readonly id: ProtectedPathsId;
  readonly points: ProtectedPathsPackPoints;
  readonly ports: ProtectedPathsPackPorts;
}
