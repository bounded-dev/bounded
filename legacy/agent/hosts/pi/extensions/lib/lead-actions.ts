// pi side of the read-only seats (ADR 2026-048): one pi tool call as the
// host-neutral action src/lead-policy.ts judges. pi-subagents' `subagent`
// tool carries several shapes in one tool; only a plain launch of one seat
// on one task is a commission the lead may make.

import { LEAD_COMMAND_TOOLS, LEAD_REPLAN_TOOL, LEAD_SETUP_TOOL, type SeatAction } from "../../../../src/lead-policy.ts";

/** The lead command each pi lead tool runs, by tool name. */
const COMMAND_OF_TOOL: ReadonlyMap<string, string> = new Map(Object.entries(LEAD_COMMAND_TOOLS).map(([command, tool]) => [tool, command]));
import { searchPatternContained } from "../../../../src/setup-state.ts";

const PROJECT_READS = new Set(["read", "grep", "find", "ls"] as const);
const LOOKUPS: ReadonlySet<string> = new Set(["web_search", "web_fetch", "skill"]);
/** Watching commissioned children, or reporting back to the commissioning seat. */
const OBSERVERS: ReadonlySet<string> = new Set(["subagent_wait", "contact_supervisor"]);
const SUBAGENT_OBSERVE_ACTIONS: ReadonlySet<unknown> = new Set(["children.list", "status", "wait"]);
/**
 * The only fields a commission may carry. Everything else pi-subagents
 * accepts (async, worktree, isolation, cwd, context, share, output,
 * sessionDir, chain, parallel, workflowScript, ...) would background, move,
 * fork, bundle or publish the seat, so an allowlist refuses it by default.
 */
const COMMISSION_FIELDS: ReadonlySet<string> = new Set(["agent", "task", "action", "agentScope", "subagent_type", "model"]);
/** The only fields a watch on commissioned children may carry. */
const OBSERVE_FIELDS: ReadonlySet<string> = new Set(["action", "id", "runId", "index", "view", "lines", "timeoutMs"]);

/** pi-subagents' parent side of the supervisor channel. The lead may see
 *  pending requests and answer one; it may not open a conversation. */
const SUPERVISOR_TOOL = "subagent_supervisor";
const SUPERVISOR_OBSERVE_ACTIONS: ReadonlySet<unknown> = new Set(["list", "pending", "status"]);
const SUPERVISOR_FIELDS: ReadonlySet<string> = new Set(["action", "to", "replyTo", "message"]);

type ProjectRead = typeof PROJECT_READS extends Set<infer T> ? T : never;

const unknownField = (input: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): string | undefined =>
  Object.keys(input).find((field) => input[field] !== undefined && !allowed.has(field));

function subagentAction(input: Readonly<Record<string, unknown>>): SeatAction {
  const action = input["action"];
  if (SUBAGENT_OBSERVE_ACTIONS.has(action)) {
    const extra = unknownField(input, OBSERVE_FIELDS);
    return extra === undefined ? { kind: "observe", tool: `subagent ${String(action)}` }
      : { kind: "refused", reason: `subagent ${String(action)} may not carry '${extra}'` };
  }
  if (action !== undefined && action !== "launch" && action !== "run") {
    return { kind: "refused", reason: `subagent action '${String(action)}' cannot be used by the lead` };
  }
  const extra = unknownField(input, COMMISSION_FIELDS);
  if (extra !== undefined) {
    return { kind: "refused", reason: `a commission must start one plain foreground seat on one task ('${extra}' is not allowed)` };
  }
  if (input["agentScope"] !== undefined && input["agentScope"] !== "project") {
    return { kind: "refused", reason: "subagents must use this project's bound definitions" };
  }
  // pi-subagents names the seat `agent`; a second role field the tool does not
  // read would let the call say one role and launch another.
  if (input["subagent_type"] !== undefined && input["subagent_type"] !== input["agent"]) {
    return { kind: "refused", reason: "subagent role fields disagree" };
  }
  return { kind: "commission", role: input["agent"], task: input["task"] };
}

function supervisorAction(input: Readonly<Record<string, unknown>>): SeatAction {
  const extra = unknownField(input, SUPERVISOR_FIELDS);
  if (extra !== undefined) return { kind: "refused", reason: `${SUPERVISOR_TOOL} may not carry '${extra}'` };
  const action = input["action"];
  if (SUPERVISOR_OBSERVE_ACTIONS.has(action)) return { kind: "observe", tool: `${SUPERVISOR_TOOL} ${String(action)}` };
  // No action is how the session-start strip asks whether the tool is held at all.
  if (action === "reply" || action === undefined) return { kind: "reply" };
  return { kind: "refused", reason: `${SUPERVISOR_TOOL} action '${String(action)}' cannot be used by the lead; it answers requests, it does not start them` };
}

/** A read whose search pattern could leave its directory or name .git is refused here, as on every host. */
function readAction(tool: ProjectRead, input: Readonly<Record<string, unknown>>): SeatAction {
  const pattern = tool === "grep" ? input["glob"] : tool === "find" ? input["pattern"] : undefined;
  if (!searchPatternContained(pattern)) {
    return { kind: "refused", reason: `${tool} patterns must stay inside the searched directory and away from .git` };
  }
  return { kind: "read", tool, input };
}

export function piSeatAction(toolName: string, input: Readonly<Record<string, unknown>>): SeatAction {
  if (PROJECT_READS.has(toolName as ProjectRead)) return readAction(toolName as ProjectRead, input);
  if (LOOKUPS.has(toolName)) return { kind: "lookup", tool: toolName };
  if (OBSERVERS.has(toolName)) return { kind: "observe", tool: toolName };
  const command = COMMAND_OF_TOOL.get(toolName);
  if (command !== undefined) return { kind: "lead-command", command };
  if (toolName === LEAD_SETUP_TOOL) return { kind: "setup" };
  if (toolName === LEAD_REPLAN_TOOL) return { kind: "replan" };
  if (toolName === "subagent") return subagentAction(input);
  if (toolName === SUPERVISOR_TOOL) return supervisorAction(input);
  return { kind: "other", tool: toolName };
}
