import { Verdict } from "bounded/domain";
import { refusedToolsIn } from "../../domain/refused-tool.ts";
import { refusedToolsId } from "../../domain/refused-tools-id.ts";
import type * as Contract from "./refuse-listed-tools.contract.ts";

/**
 * A tool use whose tool kind a contributed rule names is refused, naming
 * the kind, the pack and the project or pack that contributed the rule, with
 * the rule's redirect; the first such rule, in pack order, wins. Rules that
 * cannot be read refuse.
 */
export const refuseListedTools: Contract.RefuseListedTools = (call, composition) => {
  const point = refusedToolsIn(composition);
  const rules = point === undefined ? { ok: false as const, error: `${refusedToolsId.value} is not selected` } : composition.entries(point);
  if (!rules.ok) return Verdict.refuse(`The refused tools cannot be read: ${rules.error}`, `Select ${refusedToolsId.value} with the packs that contribute rules`);
  const refused = rules.value.find(({ value: rule }) => rule.tool === call.toolKind);
  if (refused === undefined) return Verdict.allow;
  return Verdict.refuse(`${refusedToolsId.value} refuses the tool kind '${call.toolKind}' (a rule from ${refused.fromPackId.value})`, refused.value.redirect);
};
