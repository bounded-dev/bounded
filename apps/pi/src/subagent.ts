// pi-subagents' `subagent` tool, read strictly: every field must be one the
// translation understands, so nothing it does goes undescribed. Unlike pi's
// built-in tools, it honours a `cwd` argument, so paths start there.
import type { Result } from "bounded/domain";
import type { Effect } from "./event.ts";
import type { Locate } from "./pi-path.ts";

type Fields = Readonly<Record<string, unknown>>;

/** Fields of a management call; only these actions are translated, each invoked by name. */
const ACTION_FIELDS = new Set(["action", "id", "runId", "dir", "view", "lines", "index", "message"]);
const ACTIONS = new Set(["status", "resume"]);
/** Fields of a call that runs agents, of one task, and of one chain step. */
const RUN_FIELDS = new Set(["agent", "task", "tasks", "chain", "cwd", "output", "outputMode", "model", "context", "async", "agentScope", "timeoutMs", "maxRuntimeMs"]);
const TASK_FIELDS = new Set(["agent", "task", "cwd", "output", "outputMode", "model", "label", "phase", "as", "count"]);
const STEP_FIELDS = new Set([...TASK_FIELDS, "parallel", "concurrency", "failFast"]);

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (fields: Fields, name: string): unknown => (Object.hasOwn(fields, name) ? fields[name] : undefined);

/** The effects of one subagent call, or why it cannot be translated. */
export function subagentEffects(toolName: string, input: Fields, sessionCwd: string, locate: Locate): Result<Effect[]> {
  const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error: `pi's ${toolName} call ${error}` });
  const unknownFields = (fields: Fields, allowed: ReadonlySet<string>): string | undefined => {
    const unknown = Object.keys(fields).filter((name) => !allowed.has(name));
    return unknown.length === 0 ? undefined : `has fields bounded does not translate: ${unknown.map((name) => `'${name}'`).join(", ")}`;
  };

  const action = own(input, "action");
  if (action !== undefined) {
    if (typeof action !== "string" || !ACTIONS.has(action)) return refuse(`uses action '${String(action)}', which bounded does not translate`);
    const unknown = unknownFields(input, ACTION_FIELDS);
    return unknown === undefined ? { ok: true, value: [{ kind: "invoke", name: `${toolName}.${action}` }] } : refuse(unknown);
  }

  const effects: Effect[] = [];
  /** The directory a `cwd` field names, from `base`; `base` itself when there is none. */
  const directory = (fields: Fields, base: string): Result<string> => {
    const cwd = own(fields, "cwd");
    if (cwd === undefined) return { ok: true, value: base };
    if (typeof cwd !== "string") return refuse("has a 'cwd' that is not a string");
    const located = locate(cwd, base);
    return located.ok ? { ok: true, value: located.value.absolute } : located;
  };
  /** Adds the delegation (if `required` or named) and the output write of one call, task or step. */
  const add = (fields: Fields, base: string, required: boolean): Result<string> => {
    const where = directory(fields, base);
    if (!where.ok) return where;
    const agent = own(fields, "agent");
    if (agent !== undefined || required) {
      if (typeof agent !== "string" || agent.trim() === "") return refuse("has a task or step that names no agent");
      effects.push({ kind: "delegate", agent });
    }
    const output = own(fields, "output");
    if (typeof output === "string") {
      const located = locate(output, where.value);
      if (!located.ok) return located;
      effects.push({ kind: "write", path: located.value.path, change: located.value.exists ? "modify" : "create" });
    } else if (output !== undefined && output !== false) return refuse("has an 'output' that is not a file path or false");
    return where;
  };
  const tasks = (list: unknown, name: string, base: string): Result<null> => {
    if (!Array.isArray(list)) return refuse(`has a '${name}' that is not a list of tasks`);
    for (const task of list) {
      if (!isFields(task)) return refuse("has a task or step that names no agent");
      const unknown = unknownFields(task, TASK_FIELDS);
      if (unknown !== undefined) return refuse(unknown);
      const added = add(task, base, true);
      if (!added.ok) return added;
    }
    return { ok: true, value: null };
  };

  const unknown = unknownFields(input, RUN_FIELDS);
  if (unknown !== undefined) return refuse(unknown);
  const top = add(input, sessionCwd, false);
  if (!top.ok) return top;
  const [list, chain] = [own(input, "tasks"), own(input, "chain")];
  if (list !== undefined) {
    const added = tasks(list, "tasks", top.value);
    if (!added.ok) return added;
  }
  if (chain !== undefined) {
    if (!Array.isArray(chain)) return refuse("has a 'chain' that is not a list of steps");
    for (const step of chain) {
      if (!isFields(step)) return refuse("has a task or step that names no agent");
      const stepUnknown = unknownFields(step, STEP_FIELDS);
      if (stepUnknown !== undefined) return refuse(stepUnknown);
      const parallel = own(step, "parallel");
      const added = add(step, top.value, parallel === undefined);
      if (!added.ok) return added;
      if (parallel !== undefined) {
        const inner = tasks(parallel, "parallel", added.value);
        if (!inner.ok) return inner;
      }
    }
  }
  return effects.some((effect) => effect.kind === "delegate") ? { ok: true, value: effects } : refuse("names no agent");
}
