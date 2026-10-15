import type { refusedToolBrand } from "./refused-tool.contract.ts";
import { point, type Result, sameWire, type ToolKind, wireFormOf } from "bounded/domain";
import type * as Contract from "./refused-tool.contract.ts";

/**
 * Every tool kind an event can carry. The core exports the type, not the
 * list, so the pack keeps its own; were the core to add a kind, a rule naming
 * it would be refused here until the list follows, which fails closed.
 */
const TOOL_KINDS: readonly ToolKind[] = Object.freeze(["read", "search", "edit", "write", "shell", "web", "subagent", "other"]);
const FORM = "A refused tool is { tool, redirect }";
const KEYS = ["tool", "redirect"];
const MAX_TEXT = 1000;
const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** The fields of a refused tool, or why `raw` is not one. */
function check(raw: unknown): Result<Contract.RefusedToolJSON> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse(FORM);
  const keys = Object.keys(raw);
  if (keys.some((key) => !KEYS.includes(key)) || !KEYS.every((key) => keys.includes(key))) return refuse(FORM);
  const tool: unknown = Reflect.get(raw, "tool");
  const kind = TOOL_KINDS.find((known) => known === tool);
  if (kind === undefined) {
    return refuse(`${FORM}: its tool '${String(tool)}' is not a tool kind (${TOOL_KINDS.join(", ")}); events name the kind of tool, never a host's own tool name`);
  }
  const redirect: unknown = Reflect.get(raw, "redirect");
  if (typeof redirect !== "string" || redirect.trim() === "" || redirect.length > MAX_TEXT) return refuse(`${FORM}: its redirect says what to do instead, in at most ${MAX_TEXT} characters`);
  return { ok: true, value: { tool: kind, redirect: redirect.trim() } };
}

class RefusedToolImpl implements Contract.RefusedTool {
  declare readonly __brand: "RefusedTool";
  declare readonly [refusedToolBrand]: true;
  readonly #made = true;
  readonly tool: ToolKind;
  readonly redirect: string;

  private constructor(fields: Contract.RefusedToolJSON) {
    this.tool = fields.tool;
    this.redirect = fields.redirect;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class: parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is RefusedToolImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.RefusedTool> {
    if (RefusedToolImpl.made(raw)) return RefusedToolImpl.parse(wireFormOf(raw));
    const fields = check(raw);
    return fields.ok ? { ok: true, value: new RefusedToolImpl(fields.value) } : fields;
  }

  equals(other: Contract.RefusedTool): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.RefusedToolJSON {
    return { tool: this.tool, redirect: this.redirect };
  }
}

export type RefusedTool = Contract.RefusedTool;
export const RefusedTool: Contract.RefusedToolFactory = RefusedToolImpl;

/** The refused-tools pack's point, as declared in its pack: the tool kinds a project refuses. The pack ships none of its own. */
export const refusedToolsPoint = point({
  description: "Tool kinds no agent may use, each with what to do instead",
  check: RefusedTool.parse,
  values: [],
});

/** The refused-tools pack's rules in a composition: the point its pack made from refusedToolsPoint, or undefined when it is not selected. */
export const refusedToolsIn: Contract.RefusedToolsIn = (composition) => composition.pointDeclaredBy(refusedToolsPoint);
