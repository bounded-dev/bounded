// pi-subagents' `subagent` tool, read strictly: every field must be one the
// translation understands, so nothing it does goes undescribed. Unlike pi's
// built-in tools, it honours a `cwd` argument, so paths start there.
import type { Result } from "bounded/domain";
import type { PiEffectJSON } from "./event.ts";
import type { Locate } from "./pi-path.ts";
import type { AgentOfRun, TranslationResult } from "./translate.ts";

type Fields = Readonly<Record<string, unknown>>;

/** What an untied resume is told to do instead (ADR 2026-028). */
export const UNTIED_RESUME_REDIRECT = "Start a new run of the agent instead: subagent({ agent, task }) with the agent and the task you meant to resume";

/** Fields of a management call; only these actions are translated: a status invoked by name, a resume as below. */
const ACTION_FIELDS = new Set(["action", "id", "runId", "dir", "view", "lines", "index", "message"]);
const ACTIONS = new Set(["status", "resume"]);
/** Fields of a call that runs agents, of one task, and of one chain step. */
const RUN_FIELDS = new Set(["agent", "task", "tasks", "chain", "cwd", "output", "outputMode", "model", "context", "async", "agentScope", "timeoutMs", "maxRuntimeMs"]);
const TASK_FIELDS = new Set(["agent", "task", "cwd", "output", "outputMode", "model", "label", "phase", "as", "count"]);
const STEP_FIELDS = new Set([...TASK_FIELDS, "parallel", "concurrency", "failFast"]);

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (fields: Fields, name: string): unknown => (Object.hasOwn(fields, name) ? fields[name] : undefined);

/** Whether `text` can be shown in a refusal as it is: at most 256 characters, none of them a control character. */
const plain = (text: string): boolean => text.length <= 256 && [...text].every((character) => (character.codePointAt(0) ?? 0) >= 0x20 && character !== "\u007f");

/**
 * The agent a resume revives, when bounded can tie it (ADR 2026-028): the
 * call names its run by exactly one of `id` and `runId`, as non-empty text,
 * with no `dir` and an `index` that is absent or 0, and `agentOfRun` gives the
 * agent bounded saw that run launched and finish as. Otherwise, how the call
 * names the run, for the refusal.
 */
function resumedAgent(input: Fields, agentOfRun: AgentOfRun | undefined): { readonly agent: string } | { readonly untied: string } {
  const index = own(input, "index");
  if (own(input, "dir") !== undefined || (index !== undefined && index !== 0)) return { untied: "a run it names by directory or index" };
  const named = [own(input, "id"), own(input, "runId")].filter((value) => value !== undefined);
  const [runId] = named;
  if (named.length !== 1 || typeof runId !== "string" || runId === "") return { untied: "a run it does not name by exactly one run id" };
  const agent = agentOfRun?.(runId);
  if (agent !== undefined) return { agent };
  return { untied: plain(runId) ? `run '${runId}'` : "a run it names by an id that is not plain text" };
}

/** The effects of one subagent call, or why it cannot be translated; a resume's agent is looked up in `agentOfRun`. */
export function subagentEffects(toolName: string, input: Fields, sessionCwd: string, locate: Locate, agentOfRun?: AgentOfRun): TranslationResult<PiEffectJSON[]> {
  const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error: `pi's ${toolName} call ${error}` });
  const unknownFields = (fields: Fields, allowed: ReadonlySet<string>): string | undefined => {
    const unknown = Object.keys(fields).filter((name) => !allowed.has(name));
    return unknown.length === 0 ? undefined : `has fields bounded does not translate: ${unknown.map((name) => `'${name}'`).join(", ")}`;
  };

  const action = own(input, "action");
  if (action !== undefined) {
    if (typeof action !== "string" || !ACTIONS.has(action)) return refuse(`uses action '${String(action)}', which bounded does not translate`);
    const unknown = unknownFields(input, ACTION_FIELDS);
    if (unknown !== undefined) return refuse(unknown);
    // A run directory names where the run's files are; it must be in the project.
    const dir = own(input, "dir");
    if (dir !== undefined) {
      if (typeof dir !== "string") return refuse("has a 'dir' that is not a string");
      const located = locate(dir, sessionCwd);
      if (!located.ok) return located;
    }
    const invoked: PiEffectJSON = { kind: "invoke", name: `${toolName}.${action}` };
    if (action !== "resume") return { ok: true, value: [invoked] };
    // A resume revives an agent's run with no delegation of its own: it is judged as a delegation to the
    // agent bounded tied to that run, its finish unreported (a resumed run never counts), and refused,
    // whatever the project's rules, when bounded tied none (ADR 2026-028).
    const resumed = resumedAgent(input, agentOfRun);
    if ("untied" in resumed) {
      const why = `resumes ${resumed.untied}, which bounded did not see launched and finish as one agent in this pi session, so it cannot tell which agent would run`;
      return { ...refuse(why), redirect: UNTIED_RESUME_REDIRECT };
    }
    return { ok: true, value: [{ kind: "delegate", agent: resumed.agent, finishUnreported: true }, invoked] };
  }

  const effects: PiEffectJSON[] = [];
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
      effects.push({ kind: "write", path: located.value.path.value, change: located.value.exists ? "modify" : "create" });
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
  // Agents found outside the project are not the project's to vouch for.
  const scope = own(input, "agentScope");
  if (scope !== undefined && scope !== "project") return refuse(`uses agentScope '${String(scope)}'; only 'project' is translated`);
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
  if (!effects.some((effect) => effect.kind === "delegate")) return refuse("names no agent");
  // Whether the run goes on in the background is read from its result, never from `async`: a
  // background run's finish is reported on pi's event bus, and a foreground result says how its run
  // stopped (ADR 2026-028).
  const runsAsync = own(input, "async");
  if (runsAsync !== undefined && typeof runsAsync !== "boolean") return refuse("has an 'async' that is not true or false");
  return { ok: true, value: effects };
}
