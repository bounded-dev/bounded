import { type Composition, Verdict, type ListEffect, type WriteEffect } from "bounded/domain";
import { pathGateId } from "../../domain/path-gate-id.ts";
import type { ProtectedPath } from "../../domain/protected-path.contract.ts";
import { protectedPathsIn } from "../../domain/protected-path.ts";
import type * as Contract from "./judge-calls.contract.ts";

// The path gate's guards: reads, listings and writes judged against its
// protected paths, and shell commands by what the core's reading of them
// says they read, list and write (ADR 2026-020). Each reads the protected
// paths from the composition it is given.

/** Why a rule denies, and the redirect when it is not the rule's own. */
type Denial = { readonly what: string; readonly redirect?: string } | undefined;

/**
 * Asks each rule, in pack order, why it denies; the first that does refuses,
 * naming the rule's match and the pack that contributed it, with the rule's
 * redirect (or one composed from it). Rules that cannot be read refuse.
 */
function firstDenial(composition: Composition, denies: (rule: ProtectedPath) => Denial): Verdict {
  const point = protectedPathsIn(composition);
  const rules = point === undefined ? { ok: false as const, error: `${pathGateId.value} is not selected` } : composition.entries(point);
  if (!rules.ok) {
    return Verdict.refuse(`The protected paths cannot be read: ${rules.error}`, `Select ${pathGateId.value} with the packs that contribute rules`);
  }
  for (const { fromPackId, value: rule } of rules.value) {
    const denial = denies(rule);
    if (denial === undefined) continue;
    const why = rule.why === undefined ? "" : ` (${rule.why})`;
    return Verdict.refuse(`the rule '${rule.match}' from ${fromPackId.value} ${denial.what}${why}`, denial.redirect ?? rule.redirect);
  }
  return Verdict.allow;
}

/**
 * The redirect for a listing or search of `root` that could reach a rule's
 * paths: a narrower root, and a filter only where one can help; or, when
 * neither can, the honest options.
 */
function elsewhere(verb: "List" | "Search", rule: ProtectedPath, root: string): string {
  if (rule.unavoidable()) {
    const [noun, act] = verb === "List" ? ["listing", "name"] : ["search", "read"];
    return `No ${noun} can avoid '${rule.match}'; ${act} the files you need directly, or ask a person — ${rule.redirect}`;
  }
  const filter = rule.filterable() ? `, or give a filter that cannot match '${rule.match}'` : "";
  if (root === ".") return `${verb} a narrower path (not the whole project)${filter === "" ? ` that cannot reach '${rule.match}'` : filter} — ${rule.redirect}`;
  return `${verb} a root outside '${rule.match}'${filter} — ${rule.redirect}`;
}

/** Why `rule` denies reading the file `path`, or undefined: what every read, from a file tool or a shell command, is judged by. */
function readDenial(rule: ProtectedPath, path: string): Denial {
  return rule.deny.includes("read") && rule.matches(path) ? { what: `denies read of '${path}'` } : undefined;
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
  if (rule.matches(path)) return { what: `denies ${change} of '${path}'` };
  if (change === "delete" && rule.contains(path)) return { what: `denies delete, and deleting '${path}' could delete a path it matches` };
  return undefined;
}

/**
 * A read of a file is judged by the file. A read over a root the same call
 * also lists is the read half of a content search (ADR 2026-006): it could
 * read any file the listing reaches, so it is judged as reaching them.
 */
export const judgeRead: Contract.JudgeRead = (effect, composition, call) => {
  const path = effect.path.value;
  const searches = call.effects.filter((other): other is ListEffect => other.kind === "list" && other.root.value.toLowerCase() === path.toLowerCase());
  return firstDenial(composition, (rule) => {
    const direct = readDenial(rule, path);
    if (direct !== undefined || !rule.deny.includes("read")) return direct;
    const search = searches.find((list) => rule.reaches(list.root.value, filterOf(list)));
    if (search === undefined) return undefined;
    return { what: `denies read, and searching '${search.root.value}' could read a path it matches`, redirect: elsewhere("Search", rule, search.root.value) };
  });
};

/** Why `rule` denies listing `root` (by a name `filter`, or none), or undefined: what every listing, from a file tool or a shell command, is judged by. */
function listDenial(rule: ProtectedPath, root: string, filter: string | null): Denial {
  return rule.deny.includes("list") && rule.reaches(root, filter)
    ? { what: `denies list, and listing '${root}' could reveal a path it matches`, redirect: elsewhere("List", rule, root) }
    : undefined;
}

/** A listing's file-name filter as text, or null when it has none. */
const filterOf = (list: ListEffect): string | null => (list.filter === null ? null : list.filter.value);

export const judgeList: Contract.JudgeList = (effect, composition) => firstDenial(composition, (rule) => listDenial(rule, effect.root.value, filterOf(effect)));

export const judgeWrite: Contract.JudgeWrite = (effect, composition) => firstDenial(composition, (rule) => writeDenial(rule, effect.path.value, effect.change));

const UNCHECKED = "the path gate cannot check shell commands";
const UNREAD_REDIRECT = "Open the project with openProject (bounded/open-project) and a shell command reader, and reinstall bounded's dependencies if its parser cannot load; shell commands are refused until then";

/**
 * A shell command is judged by the core's reading of it (ADR 2026-020): the
 * paths it reads, lists and writes, each judged exactly as a file tool's
 * read, listing or write, reads first, then listings, then writes. What only
 * the shell can resolve (globs, variables, substitutions' output, files
 * programs open by themselves) is not guessed at: it is allowed. A command
 * bounded did not read, or could not, is refused. Confining the command at
 * the operating-system level is the real control; drift undoes its writes
 * to watched files.
 */
export const judgeExecute: Contract.JudgeExecute = (effect, composition) => {
  const { reading } = effect;
  if (reading === null) return Verdict.refuse(`${UNCHECKED}: bounded did not read this command; openProject's judge, given a shell command reader, reads every command`, UNREAD_REDIRECT);
  if (reading.outcome === "unread") return Verdict.refuse(`${UNCHECKED}: ${reading.why}`, UNREAD_REDIRECT);
  const judged = (what: string, verdict: Verdict): Verdict | undefined => (verdict.kind === "refuse" ? Verdict.refuse(`this command ${what} — ${verdict.reason}`, verdict.redirect) : undefined);
  for (const { effect: read } of reading.fileEffects) {
    if (read.kind !== "read") continue;
    const path = read.path.value;
    const refused = judged(`reads '${path}'`, firstDenial(composition, (rule) => readDenial(rule, path)));
    if (refused !== undefined) return refused;
  }
  for (const { effect: list } of reading.fileEffects) {
    if (list.kind !== "list") continue;
    const root = list.root.value;
    const refused = judged(`lists '${root}'`, firstDenial(composition, (rule) => listDenial(rule, root, filterOf(list))));
    if (refused !== undefined) return refused;
  }
  for (const { effect: write, existenceUnknown } of reading.fileEffects) {
    if (write.kind !== "write") continue;
    const { change } = write;
    const path = write.path.value;
    const both = existenceUnknown === true ? " (whether it exists could not be determined, so it is judged as both a create and a modify)" : "";
    const refused = judged(`${change === "delete" ? "deletes" : "writes"} '${path}'${both}`, firstDenial(composition, (rule) => writeDenial(rule, path, change)));
    if (refused !== undefined) return refused;
  }
  return Verdict.allow;
};
