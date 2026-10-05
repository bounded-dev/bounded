// A long gate's background run (ADR 2026-073): the one command of the job
// src/gate-jobs.ts starts.
//
//   node gate-job-worker.ts <packs-dir> <cwd> <gate> <args-json>
//
// It finds the gate in the packs directory it was given on its argv (never
// from a file), runs its `prepare`, records the project's tree, runs the gate,
// records the tree again, and hands all three back as the job's payload. It
// calls the gate directly, never through runGate, so a job never detaches
// again. Inside the job the host's deadline is the job's own time limit, and
// BOUNDED_JOB_DIR is set (src/detached-job.ts).

import { gateError, type GateResult } from "./gate-result.ts";
import { discoverGates } from "./gate-discovery.ts";
import { logGuardEvent } from "./guard-log.ts";
import { isMainModule } from "./is-main-module.ts";
import { writeJobPayload } from "./detached-job.ts";
import { treeFingerprint } from "./tree-fingerprint.ts";
import type { GatePayload } from "./gate-jobs.ts";

async function work(packs: string, cwd: string, name: string, rawArgs: string): Promise<GatePayload> {
  const gate = (await discoverGates(packs)).find((g) => g.name === name);
  if (gate === undefined) {
    const tree = treeFingerprint(cwd, packs);
    return { result: gateError(name, `no gate '${name}' in the harness's packs`, "unknown-gate"), startTree: tree, endTree: tree };
  }
  const prepared = gate.prepare === undefined ? undefined : await gate.prepare(cwd);
  const startTree = treeFingerprint(cwd, packs);
  if (prepared !== undefined) return { result: prepared, startTree, endTree: startTree };
  let result: GateResult;
  try {
    result = await gate.run(cwd, JSON.parse(rawArgs) as Record<string, unknown>);
  } catch (e) {
    // A gate that throws could not run, here as on the command line.
    result = gateError(name, e instanceof Error ? e.message : String(e), "threw");
    logGuardEvent(cwd, { guard: name, verdict: "error", summary: result.summary, detail: result.detail });
  }
  return { result, startTree, endTree: treeFingerprint(cwd, packs) };
}

if (isMainModule(import.meta.url)) {
  const [packs, cwd, name, rawArgs] = process.argv.slice(2);
  if (packs === undefined || cwd === undefined || name === undefined || rawArgs === undefined) {
    process.stderr.write("usage: node gate-job-worker.ts <packs-dir> <cwd> <gate> <args-json>\n");
    process.exit(64);
  }
  writeJobPayload(await work(packs, cwd, name, rawArgs));
  // A gate may leave timers or handles behind; the payload is the product.
  process.exit(0);
}
