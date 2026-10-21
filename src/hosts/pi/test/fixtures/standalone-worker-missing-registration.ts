import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";

const [projectRoot, version] = process.argv.slice(2);
if (projectRoot === undefined || version === undefined) throw new Error("worker fixture arguments are missing");

mock.module("../../extension.ts", () => ({
  piExtension: () => (pi: {
    on: (event: string, handler: (event: unknown, context: unknown) => Promise<unknown>) => void;
    events: { on: (event: string, handler: (event: unknown) => Promise<void>) => void };
  }) => {
    appendFileSync(join(projectRoot, "registrations.log"), "mock registered\n");
    pi.on("session_start", async () => undefined);
    pi.events.on("subagent:async-complete", async () => undefined);
    // A broken adapter omits tool_call and tool_result entirely.
  },
}));

const { runStandalonePiWorker } = await import("../../standalone-worker.ts");
await runStandalonePiWorker(projectRoot, version, {
  capture: async () => ({ modulePath: "fixture", digest: "fixture" }),
  configSource: () => ({ load: async () => ({ ok: false as const, error: "unused fixture source" }) }),
  dispose: () => {},
});
