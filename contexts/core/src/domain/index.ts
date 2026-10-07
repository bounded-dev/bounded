export type { Result } from "./shared/result.ts";

export type { CompositionFactory } from "./composition/composition.contract.ts";
export { Composition } from "./composition/composition.ts";
export type {
  AnyPack,
  AnyPoint,
  Contribution,
  Declarations,
  ExtensionPoint,
  Pack,
  PackFactory,
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
export type { Change, DelegateEffect, EffectFactory, EffectKind, ExecuteEffect, FetchEffect, ListEffect, ReadEffect, WriteEffect } from "./events/effect.contract.ts";
export { describeEffect, Effect } from "./events/effect.ts";
export { ToolUse } from "./events/tool-use.ts";
export type { Dispatch, Guard } from "./guards/guard.contract.ts";
export { dispatch } from "./guards/dispatch.ts";
export type { Allow, Refuse, VerdictFactory } from "./verdicts/verdict.contract.ts";
export { Verdict } from "./verdicts/verdict.ts";
