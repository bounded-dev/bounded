// Fixtures for the team lead's run boundary (ADR LEG-2026-048): a throwaway
// project-local installation and the guard-log lines its tests need.

import { makeTempProject, type TempProject } from "./temp-project.ts";

/** A project-local installation with ticket-numbered design notes. */
export function makeLeadProject(files: Readonly<Record<string, string>> = {}): TempProject {
  return makeTempProject({
    ".bounded/installation.json": "{}\n",
    ".bounded/harness/.keep": "",
    "docs/tn/README.md": "# Technical notes\n",
    ...files,
  }, { prefix: "lead-" });
}

type Line = Readonly<Record<string, unknown>>;

export const logLines = (...events: readonly Line[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

export const prepared = (ticket: string): Line => ({
  ts: "t", guard: "team-lead", verdict: "pass", summary: `team-lead: first run prepared for ticket #${ticket}`,
  detail: { kind: "run-prepared", ticket, boundary: "first" },
});
export const runStart: Line = { ts: "t", guard: "run-start", verdict: "pass", summary: "run started" };
export const delivered: Line = { ts: "t", guard: "deliver", verdict: "pass", summary: "delivered", detail: { step: "summary" } };
export const leadTier: Line = {
  ts: "t", guard: "model-tier", verdict: "pass", summary: "designModel",
  detail: { role: "team-lead", kind: "tier-injected" },
};
export const workerEvidence: Line = { ts: "t", guard: "phase-gate", verdict: "block", summary: "spawn refused", detail: { role: "architect" } };

export const MANIFEST = (ticket: string): string => `.bounded/tickets/${ticket}/contract-checksums.json`;
export const LOG = ".bounded/guard-log.jsonl";
