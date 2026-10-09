import type { toolResultBrand } from "./tool-result.contract.ts";
import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import type { CallId } from "./call-id.contract.ts";
import type { Effect } from "./effect.contract.ts";
import type { Role } from "./role.contract.ts";
import type * as Contract from "./tool-result.contract.ts";
import type { ToolKind } from "./tool-use.contract.ts";
import { type Call, callOf } from "./tool-use.ts";

class ToolResultImpl implements Contract.ToolResult {
  declare readonly __brand: "ToolResult";
  declare readonly [toolResultBrand]: true;
  readonly #made = true;
  readonly kind = "tool-result" as const;
  readonly role: Role | null;
  readonly toolKind: ToolKind;
  readonly effects: readonly [Effect, ...Effect[]];
  readonly ok: boolean;
  declare readonly callId?: CallId;
  declare readonly delegatedAgentRuns?: readonly Contract.DelegatedAgentRun[];

  private constructor(call: Call, ok: boolean, delegatedAgentRuns: readonly Contract.DelegatedAgentRun[] | undefined) {
    this.role = call.role;
    this.toolKind = call.tool;
    this.effects = call.effects;
    this.ok = ok;
    if (call.callId !== undefined) this.callId = call.callId;
    if (delegatedAgentRuns !== undefined) this.delegatedAgentRuns = delegatedAgentRuns;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is ToolResultImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<ToolResult> {
    return readSafely("A tool result", () => {
      if (ToolResultImpl.made(raw)) return ToolResultImpl.parse(wireFormOf(raw));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "A tool result is an object: { role, tool, effects, ok, callId? }" };
      const kind = own(raw, "kind");
      if (kind !== undefined && kind !== "tool-result") return { ok: false, error: `A tool result has kind 'tool-result', not '${show(kind)}'` };
      const ok = own(raw, "ok");
      if (typeof ok !== "boolean") return { ok: false, error: "A tool result says whether the tool succeeded: ok is true or false" };
      // The rest is a tool use's, checked the same way: its execute effects carry their reading too (ADR 2026-020).
      const call = callOf(raw, "A tool use");
      if (!call.ok) return call;
      const runs = delegatedAgentRunsOf(own(raw, "delegatedAgentRuns"), call.value.effects.filter((effect) => effect.kind === "delegate").length);
      return runs.ok ? { ok: true, value: new ToolResultImpl(call.value, ok, runs.value) } : runs;
    });
  }

  equals(other: ToolResult): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.ToolResultJSON {
    const json = { kind: this.kind, role: this.role === null ? null : this.role.value, tool: this.toolKind, effects: this.effects.map((effect) => effect.toJSON()), ok: this.ok };
    return {
      ...json,
      ...(this.callId === undefined ? {} : { callId: this.callId.value }),
      ...(this.delegatedAgentRuns === undefined ? {} : { delegatedAgentRuns: this.delegatedAgentRuns.map(({ finished, finishNeverReported }) => (finishNeverReported === true ? { finished, finishNeverReported } : { finished })) }),
    };
  }
}

const RUNS = "A tool result's delegatedAgentRuns is a list of { finished } entries, one per delegate effect";
const RUN = "A tool result's delegatedAgentRuns entry is { finished }, with finished true or false";
const NEVER = "A tool result's delegatedAgentRuns entry may say finishNeverReported: true, and only when finished is false";
const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** What the host says of each delegated run, checked against the number of delegate effects; undefined when it says nothing. */
function delegatedAgentRunsOf(raw: unknown, delegates: number): Result<readonly Contract.DelegatedAgentRun[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (delegates === 0) return { ok: false, error: "A tool result without a delegate effect has no delegatedAgentRuns" };
  if (!Array.isArray(raw)) return { ok: false, error: RUNS };
  const runs: Contract.DelegatedAgentRun[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { ok: false, error: RUN };
    const keys = Object.keys(entry);
    const finished = own(entry, "finished");
    const never = own(entry, "finishNeverReported");
    if (keys.some((key) => key !== "finished" && key !== "finishNeverReported") || typeof finished !== "boolean") return { ok: false, error: RUN };
    if (keys.includes("finishNeverReported") && (never !== true || finished)) return { ok: false, error: NEVER };
    runs.push(Object.freeze(never === true ? { finished, finishNeverReported: true as const } : { finished }));
  }
  if (runs.length !== delegates) {
    return { ok: false, error: `A tool result's delegatedAgentRuns has one entry per delegate effect: ${counted(delegates, "effect", "effects")}, ${counted(runs.length, "entry", "entries")}` };
  }
  return { ok: true, value: Object.freeze(runs) };
}

export type ToolResult = Contract.ToolResult;
export const ToolResult: Contract.ToolResultFactory = ToolResultImpl;
