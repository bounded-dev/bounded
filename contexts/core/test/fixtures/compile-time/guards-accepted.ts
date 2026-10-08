// The legitimate forms of guard contributions. Compiles without errors.
import { type AfterToolReport, contribution, corePack, definePack, portKeysFor, Ports, type Effect, type Event, type ExecuteEffect, type Guard, type ReadEffect, type SessionStart, type ToolUse, Verdict, type WriteEffect } from "bounded/domain";
import { base, packId } from "./packs.ts";

const guards = corePack.points;

// Whole-call guards, for one event kind or any.
const noEditTools: Guard<ToolUse> = (use) => (use.toolKind === "edit" ? Verdict.refuse("No editing tools", "Use the generator") : Verdict.allow);
const needsRole: Guard<Event> = (event) => (event.role === null ? Verdict.refuse("No role", "Start as a role") : Verdict.allow);
const onStart: Guard<SessionStart> = () => Verdict.allow;
// Effect guards: one effect of their kind, the composition, and the whole call.
const noGenerated = (effect: WriteEffect) => (effect.path.value.startsWith("generated/") ? Verdict.refuse("Generated", "Change the generator's input") : Verdict.allow);
const anyEffect = (effect: Effect) => (effect.kind === "fetch" ? Verdict.refuse("Offline", "Work offline") : Verdict.allow);
const noForce = (effect: ExecuteEffect) => (effect.command.value.includes("--force") ? Verdict.refuse("Forced", "Run it without --force") : Verdict.allow);

export const gate = definePack({
  id: packId("gate"),
  dependsOn: [corePack, base],
  contributes: [
    contribution(guards.toolUseGuards, [noEditTools, needsRole]),
    contribution(guards.sessionStartGuards, [onStart, needsRole]),
    contribution(guards.effectGuards.write, [noGenerated, anyEffect]),
    contribution(guards.effectGuards.execute, [noForce]),
    contribution(guards.effectGuards.read, [
      (effect: ReadEffect, composition, call) => {
        const words = composition.read(base.points.words);
        return call.role !== null && words.ok && words.value.includes(effect.path.value) ? Verdict.refuse("A word", "Read another file") : Verdict.allow;
      },
    ]),
  ],
});

// Lifecycle checks: async, given the call or result and the context (composition and ports); a pack declares the ports it reads.
interface Files {
  read(path: string): string;
}
const lockId = packId("lock");
const files = portKeysFor(lockId)<Files>("files");
const nothing: AfterToolReport = { message: null, record: null };
export const lock = definePack({
  id: lockId,
  dependsOn: [corePack],
  contributes: [
    contribution(corePack.points.beforeTool, [async (call, context) => (context.ports.get(files).ok && call.role !== null ? Verdict.allow : Verdict.refuse("No files", "Provide them"))]),
    contribution(corePack.points.afterTool, [async () => nothing]),
  ],
  ports: { files },
});
export const provided = Ports.provide(files, (root) => ({ read: (path: string) => `${root}/${path}` }));
