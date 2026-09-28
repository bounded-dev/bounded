// Dependency-free pi project entry (ADR 2026-048, ADR 2026-051). The
// generated project loader imports this file; at runtime it and everything it
// imports use Node builtins only (the pi and schema imports are type-only), so
// a fresh clone can load it before setup installs any package.
//
// Decision order, identical to the Claude Code bootstrap hook:
//   1. `lead_setup` from the lead at the project root, when setup is
//      permitted, runs the composed setup;
//   2. with dependencies ready, the full adapter decides;
//   3. before setup, or when the full adapter fails to load, the session stays
//      read-only: project-local reads by the lead, and nothing else.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { realpathSync } from "node:fs";
import { logGuardEvent } from "../../src/guard-log.ts";
import {
  dependenciesReady, projectReadAllowed, runProjectSetup, setupPermitted, type ProjectRead,
} from "../../src/setup-state.ts";

/** Must equal LEAD_SETUP_TOOL in src/lead-policy.ts; kept as a copy because
 *  this entry loads before packages exist (a test pins the two together). */
export const BOOTSTRAP_SETUP_TOOL = "lead_setup";
const BOOTSTRAP_READ_TOOLS = ["read", "ls", "grep", "find"] as const;
// A plain JSON schema: the schema library is not installed before setup.
const NO_PARAMETERS = { type: "object", properties: {}, additionalProperties: false } as unknown as TSchema;

export type ExtensionModule = { readonly default: (pi: ExtensionAPI) => unknown };

type Fields = Readonly<Record<string, unknown>>;

function note(project: string, verdict: "block" | "error", summary: string, kind: string, tool?: string): void {
  logGuardEvent(project, {
    guard: "team-lead", verdict, summary,
    detail: { host: "pi", kind, ...(tool === undefined ? {} : { tool }) },
  });
}

/** pi's local read tools, in the shared host-neutral shape. */
export function asProjectRead(tool: string, input: Fields): ProjectRead | undefined {
  switch (tool) {
    // A pathless listing or search walks the session directory, which the
    // full policy refuses as unscoped; so does this entry.
    case "read": return { path: input["path"], pathRequired: true, search: false, globs: [] };
    case "ls": return { path: input["path"], pathRequired: true, search: true, globs: [] };
    case "grep": return { path: input["path"], pathRequired: true, search: true, globs: [input["glob"]] };
    case "find": return { path: input["path"], pathRequired: true, search: true, globs: [input["pattern"] ?? null] };
    default: return undefined;
  }
}

/** Only the top-level session at the project root is the lead. Directories
 *  compare once links are resolved, as the Claude Code entry compares them. */
function leadAt(project: string, cwd: string): boolean {
  if (process.env["PI_SUBAGENT_CHILD"] === "1") return false;
  try {
    return realpathSync(cwd) === realpathSync(project);
  } catch {
    return false;
  }
}

function registerSetupTool(pi: ExtensionAPI, project: string): void {
  pi.registerTool({
    name: BOOTSTRAP_SETUP_TOOL,
    label: "Install project dependencies",
    description: "Install the composed project and local harness dependencies from their committed lockfiles. Afterwards, reload the session to activate the full Bounded guard.",
    parameters: NO_PARAMETERS,
    async execute(_id, _params, signal, _onUpdate, ctx) {
      if (!leadAt(project, ctx.cwd)) {
        const text = "team-lead: only the project-root lead may set up dependencies";
        return { content: [{ type: "text" as const, text }], details: { ok: false } };
      }
      const result = await runProjectSetup(project, { host: "pi", signal });
      const text = result.ok
        ? `${result.summary}. Reload this pi session (/reload) to activate the full Bounded guard; until then it stays read-only.`
        : result.summary;
      return { content: [{ type: "text" as const, text }], details: result };
    },
  });
}

/** The read-only setup mode: project reads and `lead_setup`, nothing else. */
export function installBootstrap(pi: ExtensionAPI, project: string): void {
  // After a partial full-adapter load, its own lead_setup (the same shared
  // setup) may already be registered; either registration serves.
  try { registerSetupTool(pi, project); } catch { /* already registered */ }
  pi.on("session_start", (_event, ctx) => {
    const lead = leadAt(project, ctx.cwd);
    const kept = pi.getActiveTools().filter((name) =>
      (lead && (BOOTSTRAP_READ_TOOLS as readonly string[]).includes(name)) ||
      (name === BOOTSTRAP_SETUP_TOOL && lead && setupPermitted(project)));
    pi.setActiveTools(kept);
  });
  pi.on("tool_call", (event, ctx) => {
    const lead = leadAt(project, ctx.cwd);
    if (event.toolName === BOOTSTRAP_SETUP_TOOL && lead && setupPermitted(project)) return undefined;
    const input: Fields = event.input !== null && typeof event.input === "object" ? event.input as Fields : {};
    const read = asProjectRead(event.toolName, input);
    if (read !== undefined && lead) {
      if (projectReadAllowed(project, ctx.cwd, read)) return undefined;
      const reason = "team-lead: before setup, reads must stay inside this project and outside .git";
      note(project, "block", reason, "bootstrap-read", event.toolName);
      return { block: true, reason };
    }
    const reason = `team-lead: dependencies are not ready; the lead may only read project files or call \`${BOOTSTRAP_SETUP_TOOL}\``;
    note(project, "block", reason, "bootstrap-setup-required", event.toolName);
    return { block: true, reason };
  });
}

/**
 * Load the full adapter when dependencies are ready, otherwise (or when it
 * fails to load) install the read-only setup mode. `loadFull` imports the
 * adapter's modules relative to the generated loader.
 */
export async function enterProject(
  pi: ExtensionAPI,
  project: string,
  loadFull: () => Promise<readonly ExtensionModule[]>,
): Promise<void> {
  if (!dependenciesReady(project)) {
    installBootstrap(pi, project);
    return;
  }
  try {
    for (const extension of await loadFull()) await extension.default(pi);
    // pi-subagents defaults to user-level roles; this project owns its roles.
    pi.on("tool_call", (event) => {
      if (event.toolName !== "subagent") return undefined;
      const input = event.input as Record<string, unknown>;
      if (input["agentScope"] === undefined) input["agentScope"] = "project";
      return undefined;
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    note(project, "error", `team-lead: full adapter load failed (${why.slice(-600)}); read-only setup mode applies`, "full-adapter-failed");
    installBootstrap(pi, project);
  }
}
