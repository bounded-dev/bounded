// A pack of fake gates for the background-job tests (ADR 2026-073): plain
// TypeScript with no harness imports, so a job's worker loads it the way it
// loads any pack. Each gate appends its name to `<cwd>/../runs.log` when its
// run ends, and logs its own pass, as a real gate does.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FAKE_JOB_PACK = `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function passed(cwd: string, name: string, lines: string[]) {
  appendFileSync(join(cwd, "..", "runs.log"), name + "\\n");
  mkdirSync(join(cwd, ".bounded"), { recursive: true });
  appendFileSync(join(cwd, ".bounded", "guard-log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), guard: name, verdict: "pass", summary: name + ": done" }) + "\\n");
  return { code: 0, verdict: "pass", summary: name + ": done", lines, detail: {} };
}
const MS = { name: "ms", kind: "number", description: "How long to sleep, in ms." };
const MARKER = { name: "marker", kind: "string", description: "A file to write next to the project when done." };
const slow = (name: string) => ({
  name, tool: name + "_gate", longRunning: "reads-tree", description: "Sleep, then pass.", flags: [MS, MARKER],
  async run(cwd: string, args: Record<string, unknown>) {
    await sleep(typeof args.ms === "number" ? args.ms : 0);
    if (typeof args.marker === "string") writeFileSync(join(cwd, "..", args.marker), "done");
    return passed(cwd, name, [name + ": done"]);
  },
});
export const gates = [
  slow("slow"),
  slow("slow3"),
  // Runs alone, as a gate that changes the tree does (review ruling on the slot).
  { ...slow("slow2"), longRunning: "writes-tree" },
  {
    name: "writer", longRunning: "reads-tree", description: "Write into the tree it judges.", flags: [],
    async run(cwd: string) { await sleep(1500); writeFileSync(join(cwd, "out.txt"), "written"); return passed(cwd, "writer", ["writer: done"]); },
  },
  {
    name: "shipper", longRunning: "writes-tree", milestone: "delivered", description: "Change the tree, then pass.", flags: [],
    async run(cwd: string) { writeFileSync(join(cwd, "shipped.txt"), "shipped"); await sleep(1500); return passed(cwd, "shipper", ["shipper: done"]); },
  },
  {
    name: "prepped", longRunning: "reads-tree", description: "Prepared before its run.", flags: [],
    async prepare(cwd: string) { writeFileSync(join(cwd, "src", "a.txt"), "restored\\n"); return undefined; },
    async run(cwd: string) { await sleep(1500); return passed(cwd, "prepped", ["prepped: done"]); },
  },
  {
    name: "quick", tool: "quick_gate", description: "Pass at once.", flags: [],
    async run(cwd: string) { return passed(cwd, "quick", ["quick: done"]); },
  },
  {
    name: "fibber", description: "Claim the running verdict with a passing code.", flags: [],
    async run() { return { code: 0, verdict: "running", summary: "still going", lines: ["fibber: still going"], detail: {} }; },
  },
  {
    name: "liar", description: "Claim to be running.", flags: [],
    async run() { return { code: 3, verdict: "running", summary: "still going", lines: ["liar: still going"], detail: {} }; },
  },
];
`;

/** Write the fake pack as `<packsDir>/fake/gates.ts`. */
export function writeFakeJobPack(packsDir: string): void {
  mkdirSync(join(packsDir, "fake"), { recursive: true });
  writeFileSync(join(packsDir, "fake", "gates.ts"), FAKE_JOB_PACK);
}
