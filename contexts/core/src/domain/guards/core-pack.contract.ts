import type { Composition } from "../composition/composition.contract.ts";
import type { WatchedPath, WatchedPathSource } from "../drift/watched-path.contract.ts";
import type { EffectByKind, EffectKind } from "../events/effect.contract.ts";
import type { ProjectPath } from "../events/project-path.contract.ts";
import type { SessionStart } from "../events/session-start.contract.ts";
import type { ToolUse } from "../events/tool-use.contract.ts";
import type { BasePack, ExtensionPoint } from "../packs/pack.contract.ts";
import type { PackId } from "../packs/pack-id.contract.ts";
import type { EffectGuard, Guard } from "./dispatch.contract.ts";

// The core pack, `bounded/core`: in one place, every way a pack plugs into
// the core. corePack is typed by this contract, so its definition must match.

/** What is at a project path: a file, a directory, something else (such as a link, never followed), or nothing. */
export type PathKind = "file" | "directory" | "other" | "absent";

/**
 * A project as it opens, for the packs that prepare for it: its root (an
 * absolute path) and a way to ask what is at a project-relative path, which
 * answers undefined when it cannot tell.
 */
export interface OpenedProject {
  readonly root: string;
  kindOfPath(path: ProjectPath): PathKind | undefined;
}

/**
 * What a pack does once when a project opens, before any event is judged,
 * such as loading what its guards need. Given the project and the
 * composition its guards will be called with. If it fails, or runs out of
 * time, the project still opens: the pack's own guards answer for it,
 * refusing what they cannot check.
 */
export type ProjectOpenHandler = (project: OpenedProject, composition: Composition) => Promise<void>;

/** The core pack's id. */
export type CoreId = PackId<"bounded/core">;

/** One guard point per effect kind, typed from EffectByKind: the only place effect kinds meet points. */
export type EffectGuardPoints = { readonly [K in EffectKind]: ExtensionPoint<EffectGuard<EffectByKind[K], Composition>, CoreId> };

/** The core pack's points, each with the values it takes and when they run (a type, not an interface, so it is a record of points as composition reads packs). */
export type CorePackPoints = {
  /** Before a tool call runs: decide the whole call (an allowlist of tools, a role's rights). The first refusal wins. */
  readonly toolUseGuards: ExtensionPoint<Guard<ToolUse, Composition>, CoreId>;
  /** When a session starts: decide whether it may. */
  readonly sessionStartGuards: ExtensionPoint<Guard<SessionStart, Composition>, CoreId>;
  /**
   * Before a tool call runs, after the whole-call guards: decide each effect
   * of the call, one point per kind (`effectGuards.read`, `.list`, `.write`,
   * `.execute`, `.fetch`, `.delegate`, `.invoke`).
   */
  readonly effectGuards: EffectGuardPoints;
  /** Once, when a project opens: prepare what guards need. */
  readonly onProjectOpen: ExtensionPoint<ProjectOpenHandler, CoreId>;
  /** Around each shell command: files it must not change, or sources that work them out; a change is undone. */
  readonly watchedPaths: ExtensionPoint<WatchedPath | WatchedPathSource, CoreId>;
};

/** The core pack: its id and its points. */
export interface CorePack extends BasePack {
  readonly id: CoreId;
  readonly points: CorePackPoints;
}
