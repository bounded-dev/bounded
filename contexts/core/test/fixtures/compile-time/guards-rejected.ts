// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
import { contribution, corePack, definePack, type Guard, type ReadEffect, type SessionStart, Verdict, type WriteEffect } from "bounded/domain";
import { packId } from "./packs.ts";

const guards = corePack.points;
declare const onStart: Guard<SessionStart>;
declare const onRead: (effect: ReadEffect) => Verdict;
declare const onWrite: (effect: WriteEffect) => Verdict;

// A guard serves only the event or effect kind of its point.
export const wrongEvent = contribution(guards.toolUseGuards, [onStart]); // rejected: is not assignable to type 'Guard<ToolUse
export const readForWrite = contribution(guards.writeGuards, [onRead]); // rejected: is not assignable to type 'EffectGuard<WriteEffect
export const writeForRead = contribution(guards.readGuards, [onWrite]); // rejected: is not assignable to type 'EffectGuard<ReadEffect
export const effectForCall = contribution(guards.toolUseGuards, [onWrite]); // rejected: is not assignable to type 'Guard<ToolUse
// A guard returns a verdict.
export const notAVerdict = contribution(guards.readGuards, [() => true]); // rejected: Type 'boolean' is not assignable to type 'Verdict'
// A pack contributing guards lists the core pack in dependsOn.
export const noCore = definePack({ id: packId("no-core"), contributes: [contribution(guards.writeGuards, [onWrite])] }); // rejected: is not assignable to type 'Contribution<never>'
// The composition a guard is given is read through typed points only.
export const readsUntyped = contribution(guards.readGuards, [(_effect, composition) => (composition.read("bounded/core.readGuards") ? Verdict.allow : Verdict.allow)]); // rejected: is not assignable to parameter of type 'ExtensionPoint
