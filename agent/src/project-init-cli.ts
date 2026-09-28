// Bounded project initializer. No model call or host launch happens here: the
// agent already running can inspect the JSON and provide explicit selections.
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { applyInit, describeInit, planInit } from "./project-init.ts";
import { SETUP_COMMAND } from "./setup-state.ts";

async function main(args: string[]): Promise<void> {
  let target = process.cwd();
  let host = "";
  const packs: string[] = [];
  let digest = "";
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
    if (["--cwd", "--host", "--pack", "--apply"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--cwd") target = resolve(value);
      if (arg === "--host") host = value;
      if (arg === "--pack") packs.push(value);
      if (arg === "--apply") digest = value;
      continue;
    }
    throw new Error(`Unknown option '${arg}'`);
  }
  if (!interactive && !host && !packs.length && !digest) {
    console.log(JSON.stringify({ ...describeInit(), target }, null, 2));
    return;
  }
  if (interactive) {
    if (digest) throw new Error("--interactive cannot be combined with --apply");
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      console.log(JSON.stringify(describeInit(), null, 2));
      if (!host) host = (await rl.question("Current agent host (pi or claude-code): ")).trim();
      if (!packs.length) packs.push(...(await rl.question("Capabilities (comma-separated): ")).split(",").map((x) => x.trim()).filter(Boolean));
      const plan = await planInit(target, host, packs);
      console.log(JSON.stringify(view("plan", plan, fullJson), null, 2));
      const answer = (await rl.question("Apply this exact plan? Type its digest: ")).trim();
      if (answer !== plan.digest) throw new Error("Digest did not match; nothing written");
      console.log(JSON.stringify(view("applied", await applyInit(target, host, packs, answer), fullJson), null, 2));
    } finally { rl.close(); }
    return;
  }
  if (!host || !packs.length) throw new Error("Supply --host and at least one --pack, or run bare bounded init for choices");
  const plan = digest ? await applyInit(target, host, packs, digest) : await planInit(target, host, packs);
  console.log(JSON.stringify(view(digest ? "applied" : "plan", plan, fullJson), null, 2));
}

function view(action: string, plan: Awaited<ReturnType<typeof planInit>>, fullJson: boolean): object {
  if (fullJson) return { action, ...plan };
  return {
    action, host: plan.host, packs: plan.packs, version: plan.version,
    filesToCreate: Object.keys(plan.createdFiles).length,
    paths: Object.keys(plan.createdFiles),
    harnessFiles: Object.keys(plan.files).length,
    digest: plan.digest,
    next: action === "plan" ? "Review these paths, then rerun with --apply <digest>. Use --json for hashes." : `Run ${SETUP_COMMAND}, then restart or trust the project in the selected agent host before relying on its gates.`,
  };
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`bounded init: BLOCK — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
