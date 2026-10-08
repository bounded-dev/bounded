import type { BasePack, ExtensionPoint, PortKey } from "bounded/domain";
import type { PathKinds, ShellParser } from "./application/judge-calls/judge-calls.contract.ts";
import type { ShellSnapshots, WatchedFiles } from "./application/watch-shell/watch-shell.contract.ts";
import type { PathGateId } from "./domain/path-gate-id.contract.ts";
import type { ProtectedPath } from "./domain/protected-path.contract.ts";

export type { PathGateId } from "./domain/path-gate-id.contract.ts";

// The path gate, `bounded/path-gate`: every way a pack or project plugs into
// it. pathGate is typed by this contract, so its definition must match.


/** The path gate's points (a type, not an interface, so it is a record of points as composition reads packs). */
export type PathGatePoints = {
  /** Deny-only path rules: what no agent may read, list, create, modify or delete, and what to do instead. */
  readonly protectedPaths: ExtensionPoint<ProtectedPath, PathGateId>;
};

/** The adapters the path gate needs a host to provide through openProject({ ports }). */
export type PathGatePorts = {
  readonly watchedFiles: PortKey<WatchedFiles, PathGateId>;
  readonly shellSnapshots: PortKey<ShellSnapshots, PathGateId>;
  readonly pathKinds: PortKey<PathKinds, PathGateId>;
  readonly shellParser: PortKey<ShellParser, PathGateId>;
};

/** The path gate pack: its id, its points and its ports. */
export interface PathGate extends BasePack {
  readonly id: PathGateId;
  readonly points: PathGatePoints;
  readonly ports: PathGatePorts;
}
