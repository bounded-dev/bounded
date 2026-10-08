// Explicit reset-time deployment probe. No probe runs during an ordinary reset.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function smokeModels(patterns, { executable = "pi", timeout = 60_000 } = {}) {
  const distinct = [...new Set(patterns.filter(Boolean))];
  if (distinct.length === 0) throw new Error("--smoke-models requires an explicit model tier");
  const cwd = mkdtempSync(join(tmpdir(), "bounded-model-smoke-"));
  try {
    for (const pattern of distinct) {
      let reply;
      try {
        reply = execFileSync(executable, [
          "--print", "--mode", "text", "--model", pattern,
          "--no-session", "--no-tools", "--no-extensions", "--no-skills",
          "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
          "--system-prompt", "Reply with OK only.", "--", "Reply with OK only.",
        ], { cwd, timeout, killSignal: "SIGKILL", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        // Provider output can contain account details; keep it out of reset logs.
        const reason = error.code === "ETIMEDOUT" ? "timed out" : "failed";
        throw new Error(`model smoke ${reason} for '${pattern}'; check provider access and deployment before resetting`);
      }
      if (!reply.trim()) throw new Error(`model smoke returned no response for '${pattern}'`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    smokeModels(process.argv.slice(2));
    console.log("dogfood-reset: configured model tiers responded to the smoke request");
  } catch (error) {
    console.error(`dogfood-reset: FATAL — ${error.message}`);
    process.exitCode = 1;
  }
}
