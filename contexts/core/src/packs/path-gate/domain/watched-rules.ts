import type * as Contract from "./watched-rules.contract.ts";
import type { WatchedPathJSON } from "./watched-path.contract.ts";
import { WatchedPath } from "./watched-path.ts";
import { WRITES } from "./protected-path.ts";

/** Whether a pattern's last part is a literal name, which the path gate reads as covering everything under it too (but for a file rule). */
const endsInName = (match: string): boolean => !/[*?[\]{}]/.test(match.split("/").at(-1) ?? "");

export const watchedRulesOf: Contract.WatchedRulesOf = (composition, protectedPaths) => {
  if (!composition.packs.includes(protectedPaths.owner)) return { ok: true, value: [] };
  const rules = composition.entries(protectedPaths);
  if (!rules.ok) return { ok: false, error: `the watched paths from ${protectedPaths.owner.id.value} cannot be read: ${rules.error}` };
  const out: Contract.Watched[] = [];
  for (const { value: rule } of rules.value) {
    if (!WRITES.some((change) => rule.deny.includes(change)) || rule.match === ".bounded" || rule.match.startsWith(".bounded/")) continue;
    const changes = WRITES.filter((change) => rule.deny.includes(change));
    const watched = { except: rule.except, changes, why: rule.why ?? `the path gate protects '${rule.match}'`, redirect: rule.redirect };
    const forms: WatchedPathJSON[] = endsInName(rule.match) && rule.file !== true ? [{ match: rule.match, ...watched }, { match: `${rule.match}/**`, ...watched }] : [{ match: rule.match, ...watched }];
    for (const form of forms) {
      const parsed = WatchedPath.parse(form);
      if (!parsed.ok) return { ok: false, error: `the watched paths from ${protectedPaths.owner.id.value} cannot be read: ${parsed.error}` };
      out.push({ rule: parsed.value, fromPackId: protectedPaths.owner.id });
    }
  }
  return { ok: true, value: Object.freeze(out) };
};
