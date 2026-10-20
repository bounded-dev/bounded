import { appendFileSync } from "node:fs";
// @ts-ignore The worker is introduced by the production commit after this red fixture.
import { runStandalonePiWorker } from "../../standalone-worker.ts";

const [projectRoot, version, marker] = process.argv.slice(2);
if (projectRoot === undefined || version === undefined || marker === undefined) throw new Error("worker disposal fixture arguments are missing");
await runStandalonePiWorker(projectRoot, version, {
  capture: async () => ({ modulePath: "fixture", digest: "fixture" }),
  configSource: () => ({ load: async () => ({ ok: false as const, error: "fixture config refusal" }) }),
  dispose: () => { appendFileSync(marker, "disposed\n"); },
});
