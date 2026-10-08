import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire } from "../shared/wire.ts";
import type { CallId } from "./call-id.contract.ts";
import type { Effect } from "./effect.contract.ts";
import type { Role } from "./role.contract.ts";
import type * as Contract from "./tool-result.contract.ts";
import type { ToolKind } from "./tool-use.contract.ts";
import { type Call, callOf } from "./tool-use.ts";

class ToolResultImpl implements Contract.ToolResult {
  declare readonly __brand: "ToolResult";
  readonly #made = true;
  readonly kind = "tool-result" as const;
  readonly role: Role | null;
  readonly tool: ToolKind;
  readonly effects: readonly [Effect, ...Effect[]];
  readonly ok: boolean;
  declare readonly callId?: CallId;

  private constructor(call: Call, ok: boolean) {
    this.role = call.role;
    this.tool = call.tool;
    this.effects = call.effects;
    this.ok = ok;
    if (call.callId !== undefined) this.callId = call.callId;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse trusts it as it is. */
  static made(raw: unknown): raw is ToolResultImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<ToolResult> {
    return readSafely("A tool result", () => {
      if (ToolResultImpl.made(raw)) return { ok: true, value: raw };
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "A tool result is an object: { role, tool, effects, ok, callId? }" };
      const kind = own(raw, "kind");
      if (kind !== undefined && kind !== "tool-result") return { ok: false, error: `A tool result has kind 'tool-result', not '${show(kind)}'` };
      const ok = own(raw, "ok");
      if (typeof ok !== "boolean") return { ok: false, error: "A tool result says whether the tool succeeded: ok is true or false" };
      // The rest is a tool use's, checked the same way.
      const call = callOf(raw, "A tool use");
      return call.ok ? { ok: true, value: new ToolResultImpl(call.value, ok) } : call;
    });
  }

  equals(other: ToolResult): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.ToolResultJSON {
    const json = { kind: this.kind, role: this.role === null ? null : this.role.value, tool: this.tool, effects: this.effects.map((effect) => effect.toJSON()), ok: this.ok };
    return this.callId === undefined ? json : { ...json, callId: this.callId.value };
  }
}

export type ToolResult = Contract.ToolResult;
export const ToolResult: Contract.ToolResultFactory = ToolResultImpl;
