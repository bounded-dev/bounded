import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import { CallId } from "./call-id.ts";
import { Effect } from "./effect.ts";
import type { Role } from "./role.contract.ts";
import { roleOf } from "./role.ts";
import type * as Contract from "./tool-use.contract.ts";

export const TOOL_KINDS: readonly Contract.ToolKind[] = ["read", "search", "edit", "write", "shell", "web", "subagent", "other"];
const EFFECTS = "A tool use's effects must be a non-empty list of what the call reads, lists, writes, executes, fetches, delegates or invokes";

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** What a tool use and a tool result share: who acts, the tool kind, its effects and call id, read and checked. */
export interface Call {
  readonly role: Role | null;
  readonly tool: Contract.ToolKind;
  readonly effects: readonly [Effect, ...Effect[]];
  readonly callId: CallId | undefined;
}

/** Reads a call's own fields, each once: role, tool, effects and the optional call id. */
export function callOf(raw: object, name: string): Result<Call> {
  const role = roleOf(raw, name);
  if (!role.ok) return role;
  const [tool, rawEffects] = [own(raw, "tool"), own(raw, "effects")];
  const known = TOOL_KINDS.find((kind) => kind === tool);
  if (known === undefined) return refuse(`Tool kind '${show(tool)}' is not one of: ${TOOL_KINDS.join(", ")}`);
  if (!Array.isArray(rawEffects) || rawEffects.length === 0) return refuse(EFFECTS);
  const effects: Effect[] = [];
  for (const [i, rawEffect] of rawEffects.entries()) {
    const effect = Effect.parse(rawEffect);
    if (!effect.ok) return refuse(`Effect ${i + 1} of ${rawEffects.length}: ${effect.error}`);
    effects.push(effect.value);
  }
  const [first, ...rest] = effects;
  if (first === undefined) return refuse(EFFECTS);
  const rawCallId = own(raw, "callId");
  const callId = rawCallId === undefined ? undefined : CallId.parse(rawCallId);
  if (callId !== undefined && !callId.ok) return callId;
  return { ok: true, value: { role: role.value, tool: known, effects: Object.freeze([first, ...rest] as const), callId: callId?.value } };
}

class ToolUseImpl implements Contract.ToolUse {
  declare readonly __brand: "ToolUse";
  readonly #made = true;
  readonly kind = "tool-use" as const;
  readonly role: Role | null;
  readonly tool: Contract.ToolKind;
  readonly effects: readonly [Effect, ...Effect[]];
  declare readonly callId?: CallId;

  private constructor(call: Call) {
    this.role = call.role;
    this.tool = call.tool;
    this.effects = call.effects;
    if (call.callId !== undefined) this.callId = call.callId;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is ToolUseImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<ToolUse> {
    return readSafely("A tool use", () => {
      if (ToolUseImpl.made(raw)) return ToolUseImpl.parse(wireFormOf(raw));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse("A tool use is an object: { role, tool, effects }");
      const kind = own(raw, "kind");
      if (kind !== undefined && kind !== "tool-use") return refuse(`A tool use has kind 'tool-use', not '${show(kind)}'`);
      const call = callOf(raw, "A tool use");
      return call.ok ? { ok: true, value: new ToolUseImpl(call.value) } : call;
    });
  }

  equals(other: ToolUse): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.ToolUseJSON {
    const json = { kind: this.kind, role: this.role === null ? null : this.role.value, tool: this.tool, effects: this.effects.map((effect) => effect.toJSON()) };
    return this.callId === undefined ? json : { ...json, callId: this.callId.value };
  }
}

export type ToolUse = Contract.ToolUse;
export const ToolUse: Contract.ToolUseFactory = ToolUseImpl;
