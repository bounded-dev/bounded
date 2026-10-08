// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
import { type CorePackPoints, type PortKey, portKeysFor, Ports, contribution, corePack, decideEvent, definePack, type Guard, type KindsMatch, type ReadEffect, type SessionStart, type ToolUse, Verdict, type WriteEffect } from "bounded/domain";
import { packId } from "./packs.ts";

const guards = corePack.points;
declare const onStart: Guard<SessionStart>;
declare const onRead: (effect: ReadEffect) => Verdict;
declare const onWrite: (effect: WriteEffect) => Verdict;

// A guard serves only the event or effect kind of its point.
export const wrongEvent = contribution(guards.toolUseGuards, [onStart]); // rejected: is not assignable to type 'Guard<ToolUse
export const readForWrite = contribution(guards.effectGuards.write, [onRead]); // rejected: is not assignable to type 'EffectGuard<WriteEffect
export const writeForRead = contribution(guards.effectGuards.read, [onWrite]); // rejected: is not assignable to type 'EffectGuard<ReadEffect
export const effectForCall = contribution(guards.toolUseGuards, [onWrite]); // rejected: is not assignable to type 'Guard<ToolUse
// A guard returns a verdict.
export const notAVerdict = contribution(guards.effectGuards.read, [() => true]); // rejected: Type 'boolean' is not assignable to type 'Verdict'
// A pack contributing guards lists the core pack in dependsOn.
export const noCore = definePack({ id: packId("no-core"), contributes: [contribution(guards.effectGuards.write, [onWrite])] }); // rejected: is not assignable to type 'Contribution<never>'
// The composition a guard is given is read through typed points only.
export const readsUntyped = contribution(guards.effectGuards.read, [(_effect, composition) => (composition.read("bounded/core.effectGuards.read") ? Verdict.allow : Verdict.allow)]); // rejected: is not assignable to parameter of type 'ExtensionPoint
// Every effect kind has a guard point, and a kind's point takes guards for that kind only.
const { invoke: _invoke, ...withoutInvoke } = guards.effectGuards;
export const noInvoke: CorePackPoints["effectGuards"] = withoutInvoke; // rejected: Property 'invoke' is missing
export const swapped: CorePackPoints["effectGuards"] = { ...guards.effectGuards, read: guards.effectGuards.write }; // rejected: is not assignable to type 'ExtensionPoint<EffectGuard<ReadEffect
// Contribute to one effect kind's point, never to the group.
export const toGroup = contribution(guards.effectGuards, [onWrite]); // rejected: is not assignable to parameter of type 'ExtensionPoint
// An effect's kind is its key.
export type Mislabelled = KindsMatch<{ read: WriteEffect }>; // rejected: does not satisfy the constraint
// Dispatch takes a composition Composition.compose made, never a look-alike.
declare const someCall: ToolUse;
export const forged = decideEvent({ __brand: "Composition", packs: [corePack] }, someCall); // rejected: is missing the following properties from type 'Composition': read, entries
export const complete = decideEvent({ __brand: "Composition", packs: [corePack], read: () => ({ ok: true, value: [] }), entries: () => ({ ok: true, value: [] }), requiredPorts: () => [] }, someCall); // rejected: Property '[compositionBrand]' is missing
// Lifecycle checks are asynchronous and answer in kind; a port's adapter is exactly its type.
export const syncBefore = contribution(guards.beforeTool, [() => Verdict.allow]); // rejected: from type 'Promise<Verdict>'
export const bareAfter = contribution(guards.afterTool, [async () => "done"]); // rejected: is not assignable to type 'AfterToolReport'
interface Files {
  read(path: string): string;
}
interface Snapshots {
  take(id: string): unknown;
}
const lockPorts = portKeysFor(packId("lock"));
const filesPort = lockPorts<Files>("files");
const snapshotsPort = lockPorts<Snapshots>("snapshots");
declare const snapshotsAdapter: Snapshots;
declare function needsSnapshots(key: PortKey<Snapshots>): void;
export const wrongAdapter = Ports.provide(filesPort, () => snapshotsAdapter); // rejected: required in type 'Files'
export const wrongKey = needsSnapshots(filesPort); // rejected: is not assignable to parameter of type 'PortKey<Snapshots
export const _snapshots = snapshotsPort;
