import type { Composition } from "../composition/composition.contract.ts";
import type { EffectByKind, EffectKind } from "../events/effect.contract.ts";
import type { SessionStart } from "../events/session-start.contract.ts";
import type { ToolUse } from "../events/tool-use.contract.ts";
import type { EffectGuard, Guard } from "../guards/dispatch.contract.ts";
import type { PointDeclaration, PointGroupDeclaration } from "../packs/pack.contract.ts";
import type { AfterTool, BeforeTool, CoreId, ProjectOpenHandler } from "./core.contract.ts";

// The core pack's points as declared, before core.pack.ts binds them into
// the pack: each takes functions, checked to be functions when contributed.

/** The core pack's id, declared before the pack. */
export type CoreIdValue = CoreId;
export type ToolUseGuardsPoint = PointDeclaration<Guard<ToolUse, Composition>>;
export type SessionStartGuardsPoint = PointDeclaration<Guard<SessionStart, Composition>>;
/** One point per effect kind, typed from EffectByKind. */
export type EffectGuardsPoint = PointGroupDeclaration<{ readonly [K in EffectKind]: PointDeclaration<EffectGuard<EffectByKind[K], Composition>> }>;
export type BeforeToolPoint = PointDeclaration<BeforeTool>;
export type AfterToolPoint = PointDeclaration<AfterTool>;
export type OnProjectOpenPoint = PointDeclaration<ProjectOpenHandler>;
