import {
  type Composition,
  contribution,
  corePack,
  definePack,
  type EffectGuard,
  type ListEffect,
  packIdsFor,
  point,
  type ReadEffect,
  Verdict,
  type WriteEffect,
} from "bounded/domain";
import { matches, reaches } from "./matching.ts";
import { ProtectedPath, writes } from "./protected-path.ts";

/**
 * The path gate's own rules: an agent can never edit its own guardrails.
 * `bounded.config.*` (any extension a loader might pick up) and `.bounded/**`
 * are refused for every write. Adapters write the guard log in `.bounded/`
 * directly, not through guards, so this does not stop them.
 */
const OWN_RULES: readonly ProtectedPath[] = [
  {
    match: "bounded.config.*",
    deny: [...writes],
    redirect: "Ask a person to change the project's Bounded configuration; describe the change you need",
    why: "the project's guardrails are changed by people, not by agents",
  },
  {
    match: ".bounded/**",
    deny: [...writes],
    redirect: "Leave .bounded/ to Bounded; ask a person if its state looks wrong",
    why: "Bounded's own state and guard log",
  },
];

const filterText = (filter: string | null): string => (filter === null ? "" : ` (${filter})`);

/**
 * Asks each rule, in pack order, why it denies; the first that does refuses,
 * naming the rule's match and the pack that contributed it, with the rule's
 * redirect. Rules that cannot be read refuse (fail closed).
 */
function firstDenial(composition: Composition, denies: (rule: ProtectedPath) => string | undefined): Verdict {
  const rules = composition.entries(pathGate.points.protectedPaths);
  if (!rules.ok) return Verdict.refuse(`The protected paths cannot be read: ${rules.error}`, `Select ${pathGate.id} with the packs that contribute rules`);
  for (const { from, value: rule } of rules.value) {
    const what = denies(rule);
    if (what !== undefined) return Verdict.refuse(`the rule '${rule.match}' from ${from} ${what}${rule.why === undefined ? "" : ` (${rule.why})`}`, rule.redirect);
  }
  return Verdict.allow;
}

/**
 * A read of a file is judged by the file. A read over a root the same call
 * also lists is the read half of a content search (ADR 2026-006): it could
 * read any file the listing reaches, so it is judged as reaching them.
 */
const onRead: EffectGuard<ReadEffect, Composition> = (effect, composition, call) => {
  const searches = call.effects.filter((other): other is ListEffect => other.kind === "list" && other.root === effect.path);
  return firstDenial(composition, (rule) => {
    if (!rule.deny.includes("read")) return undefined;
    if (matches(rule, effect.path)) return `denies read of '${effect.path}'`;
    const search = searches.find((list) => reaches(rule, list.root, list.filter));
    return search === undefined ? undefined : `denies read, and searching '${search.root}'${filterText(search.filter)} could read a path it matches`;
  });
};

const onList: EffectGuard<ListEffect, Composition> = (effect, composition) =>
  firstDenial(composition, (rule) =>
    rule.deny.includes("list") && reaches(rule, effect.root, effect.filter)
      ? `denies list, and listing '${effect.root}'${filterText(effect.filter)} could reveal a path it matches`
      : undefined,
  );

const onWrite: EffectGuard<WriteEffect, Composition> = (effect, composition) =>
  firstDenial(composition, (rule) => (rule.deny.includes(effect.change) && matches(rule, effect.path) ? `denies ${effect.change} of '${effect.path}'` : undefined));

/**
 * The path gate, `bounded/path-gate`: an ordinary pack. Packs and projects
 * contribute deny-only rules to `protectedPaths`; its guards judge reads,
 * listings and writes against them. Execute, fetch, delegate and invoke
 * effects are not judged by path here: a shell command's paths cannot be
 * read from its text (a later hash check covers them).
 */
export const pathGate = definePack({
  id: packIdsFor("bounded")("path-gate"),
  dependsOn: [corePack],
  points: {
    protectedPaths: point({ description: "Deny-only path rules: what no agent may read, list, create, modify or delete, and what to do instead", check: ProtectedPath.parse, values: OWN_RULES }),
  },
  contributes: [contribution(corePack.points.readGuards, [onRead]), contribution(corePack.points.listGuards, [onList]), contribution(corePack.points.writeGuards, [onWrite])],
});
