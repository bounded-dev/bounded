// Bounded project initializer. No model call or host launch happens here: the
// agent already running can inspect the JSON and provide explicit selections.
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { applyInit, defaultSelection, describeInit, planInit, surfaceSelection } from "./project-init.ts";
import type { SurfaceReport } from "./product-surfaces.ts";
import { SETUP_COMMAND } from "./setup-state.ts";
import { trackerConfigAtInit } from "../trackers/index.ts";

async function main(args: string[]): Promise<void> {
  let target = process.cwd();
  let host = "";
  const packs: string[] = [];
  const surfaces: string[] = [];
  const without: string[] = [];
  let digest = "";
  let project: string | undefined;
  let createStatuses = false;
  let interactive = false;
  let fullJson = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(JSON.stringify({ ...describeInit(), target }, null, 2));
      return;
    }
    if (arg === "--interactive") { interactive = true; continue; }
    if (arg === "--json") { fullJson = true; continue; }
    if (arg === "--create-statuses") { createStatuses = true; continue; }
    if (["--cwd", "--host", "--pack", "--surface", "--without", "--apply", "--project"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--cwd") target = resolve(value);
      if (arg === "--host") host = value;
      if (arg === "--pack") packs.push(value);
      if (arg === "--surface") surfaces.push(value);
      if (arg === "--without") without.push(value);
      if (arg === "--apply") digest = value;
      if (arg === "--project") project = value;
      continue;
    }
    throw new Error(`Unknown option '${arg}'`);
  }
  const bySurface = surfaces.length > 0 || without.length > 0;
  if (!interactive && !host && !packs.length && !bySurface && !digest) {
    console.log(JSON.stringify({ ...describeInit(), target }, null, 2));
    return;
  }
  if (interactive) {
    if (digest) throw new Error("--interactive cannot be combined with --apply");
    if (bySurface) throw new Error("--interactive is the technical selection; it takes no --surface or --without");
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      console.log(JSON.stringify(describeInit(), null, 2));
      if (!host) host = (await rl.question("Current agent host (pi or claude-code): ")).trim();
      if (!packs.length) packs.push(...(await rl.question("Capabilities (comma-separated; empty for all): ")).split(",").map((x) => x.trim()).filter(Boolean));
      if (!packs.length) packs.push(...defaultSelection());
      const plan = await planInit(target, host, packs);
      console.log(JSON.stringify(view("plan", plan, fullJson), null, 2));
      const answer = (await rl.question("Apply this exact plan? Type its digest: ")).trim();
      if (answer !== plan.digest) throw new Error("Digest did not match; nothing written");
      const options = { trackerConfig: trackerConfigAtInit(target, { ...(project !== undefined ? { project } : {}), createStatuses }) };
      console.log(JSON.stringify(view("applied", await applyInit(target, host, packs, answer, options), fullJson), null, 2));
    } finally { rl.close(); }
    return;
  }
  if (!host) throw new Error("Supply --host (and optionally --pack), or run bare bounded init for choices");
  // The product surfaces decide the selection from the packs' own data (ADR
  // 2026-065); any surface still open stops here with its question.
  let report: readonly SurfaceReport[] | undefined;
  if (bySurface) {
    const selection = surfaceSelection({ needed: surfaces, declined: without }, packs);
    if (selection.kind === "refused") throw new Error(selection.reason);
    if (selection.kind === "open") {
      console.log(JSON.stringify({
        action: "questions", writes: false, surfaces: selection.surfaces,
        ask: selection.questions.map(({ id, question }) => ({ surface: id, question })),
        next: "The spec leaves these surfaces open. Ask the user each question in plain language, then rerun with --surface <id> for each one needed and --without <id> for each one not needed.",
      }, null, 2));
      process.exitCode = 1;
      return;
    }
    packs.splice(0, packs.length, ...selection.packs);
    report = selection.surfaces;
  }
  // No --pack selects every installed capability: the whole stack.
  if (!packs.length) packs.push(...defaultSelection());
  // GitHub is the required tracker (ADR 2026-066): planning needs nothing
  // from it, but nothing is applied without an authenticated gh, a GitHub
  // repository here and a board with the statuses.
  const plan = digest
    ? await applyInit(target, host, packs, digest,
      { trackerConfig: trackerConfigAtInit(target, { ...(project !== undefined ? { project } : {}), createStatuses }) })
    : await planInit(target, host, packs);
  const conflicts = (report ?? []).filter((surface) => surface.declined === true);
  console.log(JSON.stringify({
    ...view(digest ? "applied" : "plan", plan, fullJson),
    ...(report ? { surfaces: report } : {}),
    ...(conflicts.length > 0 ? {
      surfaceConflicts: conflicts.map(({ id, pulledInBy }) =>
        `${id} was declined, but ${(pulledInBy ?? []).join(", ")} needs it, so it is included. Explain this to the user before applying.`),
    } : {}),
  }, null, 2));
}

function view(action: string, plan: Awaited<ReturnType<typeof planInit>>, fullJson: boolean): object {
  if (fullJson) return { action, ...plan };
  return {
    action, host: plan.host, packs: plan.packs, version: plan.version,
    ...(plan.replacement !== undefined ? {
      replaces: `the untouched installation ${plan.replacement.digest}: its files and harness copy are replaced, and setup runs again`,
      deletesSetupOutput: plan.replacement.removes,
      keepsUserFiles: plan.replacement.keeps,
    } : {}),
    filesToCreate: Object.keys(plan.createdFiles).length,
    paths: Object.keys(plan.createdFiles),
    harnessFiles: Object.keys(plan.files).length,
    digest: plan.digest,
    next: action === "plan"
      ? (plan.replacement !== undefined
        ? "This re-plan replaces the current installation and deletes the setup output listed. Explain it to the user and apply with --apply <digest> only after they explicitly agree."
        : "Review these paths, then rerun with --apply <digest>. Use --json for hashes.") : `Run ${SETUP_COMMAND}, then restart or trust the project in the selected agent host before relying on its gates.`,
  };
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`bounded init: BLOCK — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
