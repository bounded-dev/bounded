// Claude Code side of the read-only seats (ADR 2026-048): the project-local
// team lead and the scout. The decision is the host-neutral policy in
// src/lead-policy.ts; this module only turns Claude Code calls into its
// actions (tool-map.ts), parses the lead's few shell commands, rewrites them
// onto the project's own harness, and picks the commissioned architect's
// model tier. Dependency setup never reaches this hook: the dependency-free
// bootstrap hook answers the setup command itself.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logGuardEvent } from "../../src/guard-log.ts";
import { decideLead, decideScout, parseLeadPrepareArgs, parseReplanCommand, type SeatAction } from "../../src/lead-policy.ts";
import { LEAD_GUARD, LEAD_SEAT, SCOUT_SEAT } from "../../src/lead-state.ts";
import { readDevStageModels } from "../../src/dev-stage-models.ts";
import { MODEL_TIER_GUARD, planModelTier, tierSummary } from "../../src/model-tier.ts";
import { asRole, projectPathFacts } from "../../src/path-gate.ts";
import { shellWords } from "./bash-policy.ts";
import { gateInputs, isListing, listingCall } from "./listing.ts";
import { searchPatternContained } from "../../src/setup-state.ts";
import { allowWith, deny, shellQuote, type HookPayload } from "./hook-output.ts";
import { claudeSeatActions, claudeTaskModel } from "./tool-map.ts";

/** How the lead reaches the project's copied CLI from the project root. */
export const PROJECT_CLI = ".bounded/harness/scripts/bounded";
/** A lead shell command: the action it carries and, when it runs the
 *  harness CLI, the CLI arguments to run on the project's own copy. */
export interface LeadCommand {
  readonly action: SeatAction;
  readonly cli?: readonly string[];
}

const sameWords = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((word, i) => word === b[i]);

/** Parse one lead Bash command. Anything but the listed shapes is refused. */
export function leadCommand(command: unknown): LeadCommand {
  // Re-planning runs the user's own `bounded init`, which owns installation;
  // the project's copy cannot add a capability it does not hold (ADR 2026-065).
  const replan = parseReplanCommand(command, "claude-code");
  if (replan !== undefined) return { action: replan.ok ? { kind: "replan" } : { kind: "refused", reason: replan.reason } };
  const words = typeof command === "string" ? shellWords(command) : { ok: false as const };
  if (words.ok) {
    const argv = words.argv;
    const cli = argv[0] === "bounded" ? argv.slice(1)
      : argv[0] === "bash" && argv[1] === PROJECT_CLI ? argv.slice(2)
      : undefined;
    if (cli !== undefined) {
      if (sameWords(cli, ["gates", "--list"])) return { action: { kind: "lookup", tool: "gates --list" }, cli };
      if (cli[0] === "lead" && cli[1] === "prepare") {
        const parsed = parseLeadPrepareArgs(cli.slice(2));
        return parsed.ok ? { action: { kind: "prepare" }, cli } : { action: { kind: "refused", reason: parsed.reason } };
      }
    }
  }
  return { action: { kind: "refused", reason: "Bash is limited to gate discovery, run preparation and, before the first ticket, re-planning initialization in this session" } };
}

/**
 * A Bash `ls` / `find` as the read actions a read-only seat is judged on, or
 * undefined when the command is not a listing at all. Claude Code gives no
 * session a Glob tool it can rely on (listing.ts), so this is how the lead and
 * the scout see what exists rather than guess.
 */
export function listingActions(command: unknown, cwd: string): readonly SeatAction[] | undefined {
  const words = typeof command === "string" ? shellWords(command) : undefined;
  if (words === undefined || !words.ok || !isListing(words.argv)) return undefined;
  const listing = listingCall(words.argv);
  if (!listing.ok) return [{ kind: "refused", reason: listing.reason }];
  const { call } = listing;
  if (!call.patterns.every(searchPatternContained)) {
    return [{ kind: "refused", reason: "find patterns must stay inside the searched directory and away from .git" }];
  }
  // The shell follows links; the read policy judges the path as written.
  if (!projectPathFacts(cwd).asWritten?.(call.path)) {
    return [{ kind: "refused", reason: `'${call.path}' is a link, or reached through one, or spelled differently from its real name — use the real path` }];
  }
  return gateInputs(call).map((input) => ({ kind: "read" as const, tool: call.tool, input }));
}

function runOnProjectCopy(payload: HookPayload, harnessRoot: string, cli: readonly string[]): string {
  return allowWith({ ...payload.toolInput,
    command: [join(harnessRoot, "scripts", "bounded"), ...cli].map(shellQuote).join(" ") });
}

/** Project-local main-session policy. The architect is an ordinary bound
 * subagent; current Claude Code supports its nested worker commissions. */
export function evaluateLead(payload: HookPayload, cwd: string, harnessRoot: string): string {
  const refuse = (reason: string): string => {
    logGuardEvent(cwd, {
      guard: LEAD_GUARD, verdict: "block", summary: reason,
      detail: { host: "claude-code", tool: payload.toolName },
    });
    return deny(reason);
  };
  const listing = payload.toolName === "Bash" ? listingActions(payload.toolInput["command"], cwd) : undefined;
  if (listing !== undefined) {
    for (const action of listing) {
      const decision = decideLead(action, cwd);
      if (!decision.allow) return refuse(decision.reason);
    }
    return "";
  }
  if (payload.toolName === "Bash") {
    const command = leadCommand(payload.toolInput["command"]);
    const decision = decideLead(command.action, cwd);
    if (!decision.allow) return refuse(decision.reason);
    return command.cli === undefined ? "" : runOnProjectCopy(payload, harnessRoot, command.cli);
  }
  const actions = claudeSeatActions({ tool_name: payload.toolName, tool_input: payload.toolInput }, cwd);
  for (const action of actions) {
    const decision = decideLead(action, cwd);
    if (!decision.allow) return refuse(decision.reason);
  }
  const architect = actions.find((action) => action.kind === "commission" && action.role === "architect");
  return architect === undefined ? "" : architectTier(payload, cwd);
}

/** The architect seat runs on its configured tier, chosen here as on pi. */
function architectTier(payload: HookPayload, cwd: string): string {
  const model = payload.toolInput["model"];
  const plan = planModelTier({ agent: "architect", ...(model !== undefined ? { model } : {}) }, readDevStageModels(cwd));
  if (plan.kind !== "inject") return "";
  const hostModel = claudeTaskModel(plan.model);
  if (hostModel === undefined) {
    const reason = `model-tier: ${plan.key} '${plan.model}' names no model this host can run — change .bounded/dev-stage-models.json or drive this ticket under pi`;
    logGuardEvent(cwd, {
      guard: MODEL_TIER_GUARD, verdict: "block", summary: reason,
      detail: { role: LEAD_SEAT, kind: "unresolvable-tier", key: plan.key, model: plan.model },
    });
    return deny(reason);
  }
  logGuardEvent(cwd, {
    guard: MODEL_TIER_GUARD, verdict: "pass",
    summary: `${tierSummary(plan)} — as '${hostModel}' on this host`,
    detail: { role: LEAD_SEAT, kind: "tier-injected", key: plan.key, model: plan.model, hostModel },
  });
  return allowWith({ ...payload.toolInput, model: hostModel });
}

/** The scout, and any child this project's hook cannot prove is bound
 *  elsewhere: project reads only, as the lead may read them. */
export function evaluateScout(payload: HookPayload, cwd: string): string {
  const actions = payload.toolName === "Bash"
    ? listingActions(payload.toolInput["command"], cwd) ?? [{ kind: "other" as const, tool: "Bash" }]
    : claudeSeatActions({ tool_name: payload.toolName, tool_input: payload.toolInput }, cwd);
  for (const action of actions) {
    const decision = decideScout(action, cwd);
    if (!decision.allow) {
      logGuardEvent(cwd, {
        guard: "path-gate", verdict: "block", summary: decision.reason,
        detail: { host: "claude-code", role: SCOUT_SEAT, tool: payload.toolName,
          ...(payload.agentType !== undefined ? { agentType: payload.agentType } : {}) },
      });
      return deny(decision.reason);
    }
  }
  return "";
}

/**
 * True only when the project's generated definition for `agentType` carries
 * this host's PreToolUse hook bound to that same seat. Then that hook judges
 * the child's calls and the project-wide hook may stand down; anything else —
 * a forked skill, a built-in agent, a user's own definition — is unbound.
 */
export function boundDefinitionInForce(projectDir: string, agentType: string | undefined): boolean {
  if (agentType === undefined || (agentType !== SCOUT_SEAT && asRole(agentType) === undefined)) return false;
  let text: string;
  try {
    text = readFileSync(join(projectDir, ".claude", "agents", `${agentType}.md`), "utf8");
  } catch {
    return false;
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (frontmatter === undefined) return false;
  return new RegExp(`^name: ${agentType}\\s*$`, "m").test(frontmatter) &&
    /^hooks:\s*$/m.test(frontmatter) && /^ {2}PreToolUse:\s*$/m.test(frontmatter) &&
    new RegExp(`--role ${agentType}(?![\\w-])`).test(frontmatter);
}
