export type { Result } from "./shared/result.ts";

export type { CompositionFactory, Entry } from "./composition/composition.contract.ts";
export { Composition } from "./composition/composition.ts";
export type {
  AnyPack,
  AnyPoint,
  Contribution,
  Declarations,
  ExtensionPoint,
  Pack,
  PackFactory,
  PackListRules,
  PackSpec,
  PointDeclaration,
  StrictSpec,
} from "./packs/pack.contract.ts";
export { contribution, definePack, point } from "./packs/pack.ts";
export type { IsExact, PackIdFactory, Refused } from "./packs/pack-id.contract.ts";
export { PackId, packIdsFor } from "./packs/pack-id.ts";

// Events, verdicts and guards (slice 2).
export type { EventFactory } from "./events/event.contract.ts";
export { Event } from "./events/event.ts";
export type { ProjectPathFactory } from "./events/project-path.contract.ts";
export { ProjectPath } from "./events/project-path.ts";
export type { RoleFactory } from "./events/role.contract.ts";
export { Role } from "./events/role.ts";
export type { SessionStartFactory } from "./events/session-start.contract.ts";
export { SessionStart } from "./events/session-start.ts";
export type { ToolKind, ToolUseFactory } from "./events/tool-use.contract.ts";
export type { Change, DelegateEffect, EffectFactory, EffectKind, ExecuteEffect, FetchEffect, InvokeEffect, ListEffect, ReadEffect, WriteEffect } from "./events/effect.contract.ts";
export { describeEffect, Effect } from "./events/effect.ts";
export { ToolUse } from "./events/tool-use.ts";
export type { ToolResultFactory } from "./events/tool-result.contract.ts";
export { ToolResult } from "./events/tool-result.ts";
export type { WatchedPathFactory } from "./drift/watched-path.contract.ts";
export { WatchedPath } from "./drift/watched-path.ts";
export type { Dispatch, EffectGuard, Guard, Judgement } from "./guards/guard.contract.ts";
export { dispatch } from "./guards/dispatch.ts";
export { corePack } from "./guards/core-pack.ts";
export { decideEvent, dispatchEvent } from "./guards/dispatch-event.ts";
export type { DecisionFactory, RecordedVerdict } from "./decisions/decision.contract.ts";
export { Decision } from "./decisions/decision.ts";
export type { Config, ConfigFactory, ConfigSpec } from "./config/config.contract.ts";
export { composeConfig, defineConfig, isConfig } from "./config/config.ts";
export type { Allow, Refuse, VerdictFactory } from "./verdicts/verdict.contract.ts";
export { Verdict } from "./verdicts/verdict.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
