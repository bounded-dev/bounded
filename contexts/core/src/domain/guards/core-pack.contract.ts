import type { Composition } from "../composition/composition.contract.ts";
import type { EffectByKind, EffectKind } from "../events/effect.contract.ts";
import type { ToolResult } from "../events/tool-result.contract.ts";
import type { AfterToolReport } from "../lifecycle/after-tool-report.contract.ts";
import type { Ports } from "../lifecycle/ports.contract.ts";
import type { Verdict } from "../verdicts/verdict.contract.ts";
import type { SessionStart } from "../events/session-start.contract.ts";
import type { ToolUse } from "../events/tool-use.contract.ts";
import type { BasePack, ExtensionPoint } from "../packs/pack.contract.ts";
import type { PackId } from "../packs/pack-id.contract.ts";
import type { EffectGuard, Guard } from "./dispatch.contract.ts";

// The core pack, `bounded/core`: in one place, every way a pack plugs into
// the core. corePack is typed by this contract, so its definition must match.

/** A project as it opens, for the packs that prepare for it: its root, an absolute path. */
export interface OpenedProject {
  readonly root: string;
}

/**
 * What a pack does once when a project opens, before any event is judged,
 * such as loading what its guards need. Given the project and the lifecycle
 * context: the composition its guards will be called with, and the ports the
 * host provides. If it fails, or runs out of time, the project still opens:
 * the pack's own guards answer for it, refusing what they cannot check.
 */
export type ProjectOpenHandler = (project: OpenedProject, context: LifecycleContext) => Promise<void>;

/** What a lifecycle check is given besides the call or result: the composition, and the adapters the host provides for the project. */
export interface LifecycleContext {
  readonly composition: Composition;
  readonly ports: Ports;
}

/** After the guards allow a tool use, before it is recorded and runs: a refusal replaces the allow. */
export type BeforeTool = (call: ToolUse, context: LifecycleContext) => Promise<Verdict>;

/** After a tool ran: check what it did. Every after-tool check runs; what each reports is recorded and told to the agent. */
export type AfterTool = (result: ToolResult, context: LifecycleContext) => Promise<AfterToolReport>;

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
  /** After the guards allow a tool call, before it runs: asynchronous checks; a refusal replaces the allow. */
  readonly beforeTool: ExtensionPoint<BeforeTool, CoreId>;
  /** After a tool call ran: asynchronous checks; what they report is recorded and told to the agent. */
  readonly afterTool: ExtensionPoint<AfterTool, CoreId>;
  /** Once, when a project opens: prepare what guards need. */
  readonly onProjectOpen: ExtensionPoint<ProjectOpenHandler, CoreId>;
};

/** The core pack: its id and its points. */
export interface CorePack extends BasePack {
  readonly id: CoreId;
  readonly points: CorePackPoints;
}
