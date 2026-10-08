export type { Result } from "./shared/result.ts";

export type { CompositionFactory, Entry } from "./composition/composition.contract.ts";
export { Composition } from "./composition/composition.ts";
export type { AvailablePacksFactory } from "./composition/available-packs.contract.ts";
export { AvailablePacks } from "./composition/available-packs.ts";
export type { SelectedPacksFactory } from "./composition/selected-packs.contract.ts";
export { SelectedPacks } from "./composition/selected-packs.ts";
export type {
  BasePack,
  BasePoint,
  Contributed,
  Contribution,
  Declarations,
  ExtensionPoint,
  Pack,
  PackFactory,
  PackListRules,
  PackSpec,
  PointDeclaration,
  PointGroup,
  PointGroupDeclaration,
  PortSection,
  StrictMembers,
  StrictSpec,
  WireOf,
} from "./packs/pack.contract.ts";
export { contribution, definePack, point, pointGroup } from "./packs/pack.ts";
export type { IsExact, PackIdFactory, Refused } from "./packs/pack-id.contract.ts";
export { PackId, packIdsFor } from "./packs/pack-id.ts";

// Events, verdicts and guards (slice 2).
export type { EventFactory } from "./events/event.contract.ts";
export { Event } from "./events/event.ts";
export type { ProjectPathFactory } from "./events/project-path.contract.ts";
export { ProjectPath } from "./events/project-path.ts";
export type { RoleFactory } from "./events/role.contract.ts";
export { Role } from "./events/role.ts";
export type { SessionStartFactory, SessionStartJSON } from "./events/session-start.contract.ts";
export { SessionStart } from "./events/session-start.ts";
export type { AgentNameFactory } from "./events/agent-name.contract.ts";
export { AgentName } from "./events/agent-name.ts";
export type { CallIdFactory } from "./events/call-id.contract.ts";
export { CallId } from "./events/call-id.ts";
export type { CommandFactory } from "./events/command.contract.ts";
export { Command } from "./events/command.ts";
export type { NamePatternFactory } from "./events/name-pattern.contract.ts";
export { NamePattern } from "./events/name-pattern.ts";
export type { ToolNameFactory } from "./events/tool-name.contract.ts";
export { ToolName } from "./events/tool-name.ts";
export type { UrlFactory } from "./events/url.contract.ts";
export { Url } from "./events/url.ts";
export type { ToolKind, ToolUseFactory, ToolUseJSON } from "./events/tool-use.contract.ts";
export type {
  Change,
  DelegateEffect,
  DelegateEffectJSON,
  EffectByKind,
  EffectFactory,
  EffectJSON,
  EffectKind,
  ExecuteEffect,
  ExecuteEffectJSON,
  FetchEffect,
  FetchEffectJSON,
  InvokeEffect,
  InvokeEffectJSON,
  KindsMatch,
  ListEffect,
  ListEffectJSON,
  ReadEffect,
  ReadEffectJSON,
  WriteEffect,
  WriteEffectJSON,
} from "./events/effect.contract.ts";
export { describeEffect, Effect } from "./events/effect.ts";
export { ToolUse } from "./events/tool-use.ts";
export type { ToolResultFactory, ToolResultJSON } from "./events/tool-result.contract.ts";
export { ToolResult } from "./events/tool-result.ts";
export type { Dispatch, EffectGuard, Guard } from "./guards/dispatch.contract.ts";
export type { DecideEvent, DispatchEvent, Judgement } from "./guards/dispatch-event.contract.ts";
export { dispatch } from "./guards/dispatch.ts";
export { corePack } from "./guards/core-pack.ts";
export type { AfterTool, BeforeTool, CoreId, CorePack, CorePackPoints, EffectGuardPoints, LifecycleContext, OpenedProject, PathKind, ProjectOpenHandler } from "./guards/core-pack.contract.ts";
export type { BasePortKey, PortKeyFactory } from "./lifecycle/port-key.contract.ts";
export { PortKey, portKeysFor } from "./lifecycle/port-key.ts";
export type { PortProvision, PortsFactory } from "./lifecycle/ports.contract.ts";
export { Ports } from "./lifecycle/ports.ts";
export type { AfterToolReportFactory } from "./lifecycle/after-tool-report.contract.ts";
export { AfterToolReport } from "./lifecycle/after-tool-report.ts";
export { decideEvent, dispatchEvent } from "./guards/dispatch-event.ts";
export type { DecisionEvent, DecisionFactory, DecisionJSON, RecordedVerdict } from "./decisions/decision.contract.ts";
export type { AdapterRefusalFactory, AdapterRefusalJSON } from "./decisions/adapter-refusal.contract.ts";
export { AdapterRefusal } from "./decisions/adapter-refusal.ts";
export type { DecisionTimeFactory } from "./decisions/decision-time.contract.ts";
export { DecisionTime } from "./decisions/decision-time.ts";
export { Decision } from "./decisions/decision.ts";
export type { DecisionIdFactory } from "./decisions/decision-id.contract.ts";
export { DecisionId } from "./decisions/decision-id.ts";
export type { ConfigFactory, ConfigSpec } from "./config/config.contract.ts";
export { Config, defineConfig } from "./config/config.ts";
export type { Allow, AllowJSON, Refuse, RefuseJSON, VerdictFactory, VerdictJSON } from "./verdicts/verdict.contract.ts";
export { Verdict } from "./verdicts/verdict.ts";

export { sameWire, wireFormOf } from "./shared/wire.ts";
export { own, readSafely, show } from "./shared/read.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
