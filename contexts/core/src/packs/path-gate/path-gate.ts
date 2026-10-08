import {
  type Composition,
  contribution,
  corePack,
  definePack,
  type EffectGuard,
  type ExecuteEffect,
  type ListEffect,
  packIdsFor,
  point,
  type ReadEffect,
  Verdict,
  type WatchedPath,
  type WatchedPathSource,
  type WriteEffect,
} from "bounded/domain";
import { contains, filterable, matches, reaches, unavoidable } from "./matching.ts";
import { ProtectedPath, WRITES } from "./protected-path.ts";
import { describeShellCommand } from "./shell-command.ts";
import { shellQuoteParser } from "./shell-parser.shell-quote.ts";

/**
 * The path gate's own rules: an agent can never edit its own guardrails.
 * `bounded.config.*` at any depth (any extension a loader might pick up) and
 * `.bounded/**` are refused for every write. Only the configuration's entry
 * file is protected, not the modules it imports (ADR 2026-009). Adapters write the guard log in `.bounded/`
 * directly, not through guards, so this does not stop them.
 */
const OWN_RULES: readonly ProtectedPath[] = [
  {
    match: "**/bounded.config.*",
    deny: [...WRITES],
    redirect: "Ask a person to change the project's Bounded configuration; describe the change you need",
    why: "the project's guardrails are changed by people, not by agents",
  },
  {
    match: ".bounded/**",
    deny: [...WRITES],
    redirect: "Leave .bounded/ to Bounded; ask a person if its state looks wrong",
    why: "Bounded's own state and guard log",
  },
];

/** Why a rule denies, and the redirect when it is not the rule's own. */
type Denial = { readonly what: string; readonly redirect?: string } | undefined;

/**
 * Asks each rule, in pack order, why it denies; the first that does refuses,
 * naming the rule's match and the pack that contributed it, with the rule's
 * redirect (or one composed from it). Rules that cannot be read refuse.
 */
function firstDenial(composition: Composition, denies: (rule: ProtectedPath) => Denial): Verdict {
  const rules = composition.entries(pathGate.points.protectedPaths);
  if (!rules.ok) {
    return Verdict.refuse(`The protected paths cannot be read: ${rules.error}`, `Select ${pathGate.id} with the packs that contribute rules`);
  }
  for (const { from, value: rule } of rules.value) {
    const denial = denies(rule);
    if (denial === undefined) continue;
    const why = rule.why === undefined ? "" : ` (${rule.why})`;
    return Verdict.refuse(`the rule '${rule.match}' from ${from} ${denial.what}${why}`, denial.redirect ?? rule.redirect);
  }
  return Verdict.allow;
}

/**
 * The redirect for a listing or search of `root` that could reach a rule's
 * paths: a narrower root, and a filter only where one can help; or, when
 * neither can, the honest options.
 */
function elsewhere(verb: "List" | "Search", rule: ProtectedPath, root: string): string {
  if (unavoidable(rule)) {
    const [noun, act] = verb === "List" ? ["listing", "name"] : ["search", "read"];
    return `No ${noun} can avoid '${rule.match}'; ${act} the files you need directly, or ask a person — ${rule.redirect}`;
  }
  const filter = filterable(rule) ? `, or give a filter that cannot match '${rule.match}'` : "";
  if (root === ".") return `${verb} a narrower path (not the whole project)${filter === "" ? ` that cannot reach '${rule.match}'` : filter} — ${rule.redirect}`;
  return `${verb} a root outside '${rule.match}'${filter} — ${rule.redirect}`;
}

/** Why `rule` denies reading the file `path`, or undefined: what every read, from a file tool or a shell command, is judged by. */
function readDenial(rule: ProtectedPath, path: string): Denial {
  return rule.deny.includes("read") && matches(rule, path) ? { what: `denies read of '${path}'` } : undefined;
}

/**
 * Why `rule` denies this change of `path`, or undefined: what every write,
 * from a file tool or a shell command, is judged by. Deleting a directory
 * deletes everything under it, so a delete is also refused when the path
 * could hold a path a rule denies delete for (see `contains`); deleting '.'
 * always is, since the path gate's own rules cover '.bounded/**' in every
 * project.
 */
function writeDenial(rule: ProtectedPath, path: string, change: WriteEffect["change"]): Denial {
  if (!rule.deny.includes(change)) return undefined;
  if (matches(rule, path)) return { what: `denies ${change} of '${path}'` };
  if (change === "delete" && contains(rule, path)) return { what: `denies delete, and deleting '${path}' could delete a path it matches` };
  return undefined;
}

/**
 * A read of a file is judged by the file. A read over a root the same call
 * also lists is the read half of a content search (ADR 2026-006): it could
 * read any file the listing reaches, so it is judged as reaching them.
 */
const onRead: EffectGuard<ReadEffect, Composition> = (effect, composition, call) => {
  const path = effect.path.toLowerCase();
  const searches = call.effects.filter((other): other is ListEffect => other.kind === "list" && other.root.toLowerCase() === path);
  return firstDenial(composition, (rule) => {
    const direct = readDenial(rule, effect.path);
    if (direct !== undefined || !rule.deny.includes("read")) return direct;
    const search = searches.find((list) => reaches(rule, list.root, list.filter));
    if (search === undefined) return undefined;
    return { what: `denies read, and searching '${search.root}' could read a path it matches`, redirect: elsewhere("Search", rule, search.root) };
  });
};

const onList: EffectGuard<ListEffect, Composition> = (effect, composition) =>
  firstDenial(composition, (rule) =>
    rule.deny.includes("list") && reaches(rule, effect.root, effect.filter)
      ? { what: `denies list, and listing '${effect.root}' could reveal a path it matches`, redirect: elsewhere("List", rule, effect.root) }
      : undefined,
  );

const onWrite: EffectGuard<WriteEffect, Composition> = (effect, composition) => firstDenial(composition, (rule) => writeDenial(rule, effect.path, effect.change));

/**
 * A shell command is translated (shell-command.ts) into the paths it reads
 * and writes, and each is judged exactly as a file tool's read or write.
 * A redirection's write is judged as a create and as a modify, since which
 * it is cannot be known before it runs. What only the shell can resolve
 * (globs, variables, substitutions' output, scripts, an unparseable
 * command) is not guessed at: it is allowed. Confining the command at the
 * operating-system level is the real control; drift undoes its writes to
 * watched files.
 */
const onExecute: EffectGuard<ExecuteEffect, Composition> = (effect, composition) => {
  const parsed = shellQuoteParser(effect.command);
  if (!parsed.ok) return Verdict.allow;
  const { reads, writes } = describeShellCommand(parsed.value, effect.cwd);
  const judged = (verb: "reads" | "writes", path: string, verdict: Verdict): Verdict | undefined =>
    verdict.kind === "refuse" ? Verdict.refuse(`this command ${verb} '${path}' — ${verdict.reason}`, verdict.redirect) : undefined;
  for (const path of reads) {
    const refused = judged("reads", path, firstDenial(composition, (rule) => readDenial(rule, path)));
    if (refused !== undefined) return refused;
  }
  for (const { path } of writes) {
    for (const change of ["create", "modify"] as const) {
      const refused = judged("writes", path, firstDenial(composition, (rule) => writeDenial(rule, path, change)));
      if (refused !== undefined) return refused;
    }
  }
  return Verdict.allow;
};

/** Whether a pattern's last part is a literal name, which the path gate reads as covering everything under it too (but for a file rule). */
const endsInName = (match: string): boolean => !/[*?[\]{}]/.test(match.split("/").at(-1) ?? "");

/**
 * What the path gate protects from writes, as watched paths for the core's
 * check around shell commands: every rule that denies a create, modify or
 * delete, with its own exceptions (a literal name also covers what is under
 * it). Never `.bounded/`: bounded writes its own state there while judging.
 */
const watchedFromRules: WatchedPathSource = (composition) => {
  const rules = composition.entries(pathGate.points.protectedPaths);
  if (!rules.ok) throw new Error(rules.error);
  return rules.value.flatMap(({ value: rule }): WatchedPath[] => {
    if (!WRITES.some((change) => rule.deny.includes(change)) || rule.match === ".bounded" || rule.match.startsWith(".bounded/")) return [];
    const watched = { except: rule.except ?? [], why: rule.why ?? `the path gate protects '${rule.match}'`, redirect: rule.redirect };
    return endsInName(rule.match) && rule.file !== true ? [{ match: rule.match, ...watched }, { match: `${rule.match}/**`, ...watched }] : [{ match: rule.match, ...watched }];
  });
};

/**
 * The path gate, `bounded/path-gate`: an ordinary pack. Packs and projects
 * contribute deny-only rules to `protectedPaths`; its guards judge reads,
 * listings and writes against them. A shell command's paths cannot really
 * be read from its text: the path gate refuses, best effort, one that names
 * a read-protected path, and gives what it protects from writes to the
 * core's watched paths, which undo a shell command's changes. Fetch,
 * delegate and invoke are not judged by path.
 */
export const pathGate = definePack({
  id: packIdsFor("bounded")("path-gate"),
  dependsOn: [corePack],
  points: {
    protectedPaths: point({
      description: "Deny-only path rules: what no agent may read, list, create, modify or delete, and what to do instead",
      check: ProtectedPath.parse,
      values: OWN_RULES,
    }),
  },
  contributes: [
    contribution(corePack.points.readGuards, [onRead]),
    contribution(corePack.points.listGuards, [onList]),
    contribution(corePack.points.writeGuards, [onWrite]),
    contribution(corePack.points.executeGuards, [onExecute]),
    contribution(corePack.points.watchedPaths, [watchedFromRules]),
  ],
});
