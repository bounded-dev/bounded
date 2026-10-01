// Dependency-free project hook entry (ADR 2026-048, ADR 2026-051). A fresh
// clone has no harness packages, so importing path-gate-hook.ts before setup
// would fail. This entry and everything it imports use Node builtins only.
//
// Decision order, identical to the pi bootstrap:
//   1. the exact setup command from the lead at the project root, when setup
//      is permitted, goes to Claude Code's normal permission prompt;
//   2. with dependencies ready, the full policy hook decides;
//   3. before setup, or when the full hook cannot run, the session stays
//      read-only: project-local reads by the lead, and nothing else.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logGuardEvent } from "../../src/guard-log.ts";
import {
  dependenciesReady, insideProject, projectReadAllowed, replanPermitted, SETUP_COMMAND, setupPermitted,
} from "../../src/setup-state.ts";
import { parseReplanCommand } from "../../src/init-command.ts";
import { claudeProjectRead } from "./project-read.ts";

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(here, "../..");
const projectRoot = resolve(harnessRoot, "../..");

type Fields = Readonly<Record<string, unknown>>;

function deny(reason: string, kind: string): void {
  logGuardEvent(projectRoot, {
    guard: "team-lead", verdict: "block", summary: reason, detail: { host: "claude-code", kind },
  });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
  } }) + "\n");
}

const sameDir = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};

/** The working directory this call acts in, when the session belongs to this project. */
function projectContext(cwd: unknown, exactRoot: boolean): string | undefined {
  const declared = process.env.CLAUDE_PROJECT_DIR;
  if (declared === undefined || !sameDir(declared, projectRoot)) return undefined;
  const current = typeof cwd === "string" ? cwd : cwd === undefined ? process.cwd() : undefined;
  if (current === undefined || !insideProject(projectRoot, current)) return undefined;
  if (exactRoot && !sameDir(current, projectRoot)) return undefined;
  return current;
}

let raw: string | undefined;
try { raw = readFileSync(0, "utf8"); } catch { raw = undefined; }

let payload: Fields | undefined;
try {
  const parsed: unknown = raw === undefined ? undefined : JSON.parse(raw);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Fields;
} catch { payload = undefined; }

const tool = typeof payload?.["tool_name"] === "string" ? payload["tool_name"] as string : undefined;
const toolInput = payload?.["tool_input"];
const input: Fields = toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput as Fields : {};
const bound = process.argv.some((arg) => arg === "--role" || arg.startsWith("--role="));
const lead = payload !== undefined && !bound && payload["agent_id"] === undefined && payload["agent_type"] === undefined;

function bootstrapDecision(): void {
  if (raw === undefined || payload === undefined || tool === undefined) {
    deny("team-lead: the bootstrap hook could not read the tool call", "bootstrap-unreadable");
    return;
  }
  const read = claudeProjectRead(tool, input);
  const cwd = projectContext(payload["cwd"], false);
  if (read !== undefined && lead && cwd !== undefined) {
    if (projectReadAllowed(projectRoot, cwd, read)) return;
    deny("team-lead: before setup, reads must stay inside this project and outside .git", "bootstrap-read");
    return;
  }
  deny(`team-lead: dependencies are not ready; the lead may only read project files or run exactly \`${SETUP_COMMAND}\``,
    "bootstrap-setup-required");
}

function main(): void {
  if (lead && tool === "Bash" && input["command"] === SETUP_COMMAND &&
      projectContext(payload?.["cwd"], true) !== undefined && setupPermitted(projectRoot)) {
    return; // Claude Code's own permission decision applies to this exact command.
  }
  // Re-planning the installation before the first ticket (ADR 2026-065) runs
  // the user's own `bounded init`, which needs no project dependency.
  if (lead && tool === "Bash" && parseReplanCommand(input["command"], "claude-code")?.ok === true &&
      projectContext(payload?.["cwd"], true) !== undefined && replanPermitted(projectRoot)) {
    return;
  }
  if (raw !== undefined && dependenciesReady(projectRoot)) {
    const full = spawnSync(process.execPath, [join(here, "path-gate-hook.ts"), ...process.argv.slice(2)], {
      input: raw, encoding: "utf8", cwd: process.cwd(), env: process.env,
    });
    if (full.status === 0 && full.error === undefined) {
      if (full.stdout) process.stdout.write(full.stdout);
      if (full.stderr) process.stderr.write(full.stderr);
      return;
    }
    const why = full.error?.message ?? (full.stderr?.trim() || `exit ${String(full.status)}`);
    logGuardEvent(projectRoot, {
      guard: "team-lead", verdict: "error",
      summary: `team-lead: full policy hook failed (${why.slice(-600)}); read-only setup mode applies`,
      detail: { host: "claude-code", kind: "full-hook-failed" },
    });
  }
  bootstrapDecision();
}

main();
