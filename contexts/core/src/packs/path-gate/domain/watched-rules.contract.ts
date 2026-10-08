import type { Composition, ExtensionPoint, PackId, Result } from "bounded/domain";
import type { ProtectedPath } from "./protected-path.contract.ts";
import type { WatchedPath } from "./watched-path.contract.ts";

/** A watched path, and the pack it is watched for. */
export interface Watched {
  readonly rule: WatchedPath;
  readonly fromPackId: PackId;
}

/**
 * What the path gate protects from writes, as watched paths for its check
 * around shell commands: every rule that denies a create, modify or delete,
 * with its own exceptions (a literal name also covers what is under it), in
 * pack order, each watched for the path gate. Never `.bounded/`: bounded
 * writes its own state there while judging. Without the path gate selected,
 * nothing; rules that cannot be read make the watched rules unreadable, so
 * callers fail closed.
 */
export type WatchedRulesOf = (composition: Composition, protectedPaths: ExtensionPoint<ProtectedPath, PackId>) => Result<readonly Watched[]>;
