import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import type { Effect as EffectType } from "./effect.contract.ts";
import { Effect } from "./effect.ts";
import { roleOf } from "./role.ts";
import type * as Contract from "./tool-use.contract.ts";

const TOOLS: readonly Contract.ToolKind[] = ["read", "search", "edit", "write", "shell", "web", "subagent", "other"];
const EFFECTS = "A tool use's effects must be a non-empty list of what the call reads, lists, writes, executes, fetches or delegates";

const one = <T extends string>(list: readonly T[], raw: unknown): raw is T => list.some((item) => item === raw);
const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

// Each field is read once, own fields only; the result is a new frozen
// object holding nothing but the vocabulary's fields.
function check(raw: unknown): Result<ToolUse> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse("A tool use is an object: { role, tool, effects }");
  const kind = own(raw, "kind");
  if (kind !== undefined && kind !== "tool-use") return refuse(`A tool use has kind 'tool-use', not '${show(kind)}'`);
  const role = roleOf(raw, "A tool use");
  if (!role.ok) return role;
  const [tool, rawEffects] = [own(raw, "tool"), own(raw, "effects")];
  if (!one(TOOLS, tool)) return refuse(`Tool kind '${show(tool)}' is not one of: ${TOOLS.join(", ")}`);
  if (!Array.isArray(rawEffects) || rawEffects.length === 0) return refuse(EFFECTS);
  const effects: EffectType[] = [];
  for (const [i, rawEffect] of rawEffects.entries()) {
    const effect = Effect.parse(rawEffect);
    if (!effect.ok) return refuse(`Effect ${i + 1} of ${rawEffects.length}: ${effect.error}`);
    effects.push(effect.value);
  }
  const [first, ...rest] = effects;
  if (first === undefined) return refuse(EFFECTS);
  // The brand exists only in types: every tool use is made here, checked and frozen.
  return { ok: true, value: Object.freeze({ kind: "tool-use", role: role.value, tool, effects: Object.freeze([first, ...rest] as const) }) as ToolUse };
}

const parse = (raw: unknown): Result<ToolUse> => readSafely("A tool use", () => check(raw));

export type ToolUse = Contract.ToolUse;
export const ToolUse: Contract.ToolUseFactory = { parse };
