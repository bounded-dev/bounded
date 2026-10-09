import type { prerequisiteRuleBrand } from "./prerequisite-rule.contract.ts";
import { AgentName, describeEffect, type Effect, type ExecuteEffect, own, point, type Result, readSafely, sameWire, wireFormOf } from "bounded/domain";
import { checkFilePattern, pathMatcherOf } from "./file-set.ts";
import type { FileSetFingerprint } from "./file-set-fingerprint.contract.ts";
import type { PendingAgentRun } from "./pending-agent-run.contract.ts";
import type { PrerequisiteRecord } from "./prerequisite-record.contract.ts";
import type * as Contract from "./prerequisite-rule.contract.ts";
import { hasExactly, requirementKeyOf } from "./prerequisite-start.ts";
import { ProgramPrefix } from "./program-prefix.ts";

const FORM = "A prerequisite rule is { before, require, unchangedSince, redirect }";
const BEFORE = "A rule's before names one action: { delegate: <agent> }, { write: <pattern> } or { execute: <program and leading arguments> }";
const NOT_BEFORE: Contract.BeforeMatch = Object.freeze({ kind: "not-before" });
/** Paths that are never project paths, so a write there blocks no write rule. */
const DEVICE_PATH = /^\/dev\/(null|stdout|stderr|fd\/\d+)$/;
/** A write's text bounded can read but not place in the project: outside it, as written, with nothing only the shell can expand. */
const OUTSIDE_PROJECT = /^(\/|~|\.\.)/;
const SHELL_EXPANDS = /[$`*?[]/;

/**
 * What a write rule makes of a shell command's reading: it writes a path the
 * pattern matches; else it cannot see, first found in this order, an
 * unresolved write (outside the project, or only the shell can resolve; the
 * device paths are exempt), code, or a program whose name is unresolved;
 * else it is not before. Every unresolved part counts against every
 * pattern: bounded cannot know what it names.
 */
function writeMatch(pattern: string, effect: ExecuteEffect): Contract.BeforeMatch {
  const { reading } = effect;
  if (reading.outcome === "unread") return { kind: "cannot-see", why: `the command could not be read (${reading.why})`, fix: reading.cause === "too-complex" ? "simplify" : "reinstall" };
  const matches = pathMatcherOf(pattern);
  const written = reading.fileEffects.find(({ effect: fileEffect }) => fileEffect.kind === "write" && matches(fileEffect.path.value));
  if (written !== undefined && written.effect.kind === "write") return { kind: "comes-before", what: `${describeEffect(effect)}, which writes '${written.effect.path.value}'` };
  const write = reading.unresolved.find((part) => part.role === "write" && !DEVICE_PATH.test(part.text));
  if (write !== undefined) {
    return OUTSIDE_PROJECT.test(write.text) && !SHELL_EXPANDS.test(write.text)
      ? { kind: "cannot-see", why: `it writes a path bounded cannot place in the project ('${write.text}')`, fix: "inside-project" }
      : { kind: "cannot-see", why: `it writes a path only the shell can resolve ('${write.text}')`, fix: "readable" };
  }
  const code = reading.unresolved.find((part) => part.role === "code");
  if (code !== undefined) return { kind: "cannot-see", why: `it runs code bounded cannot read ('${code.text}')`, fix: "none" };
  const unresolvedName = reading.programs.find((run) => run.name.kind === "unresolved");
  if (unresolvedName !== undefined) return { kind: "cannot-see", why: `it runs a program whose name only the shell can resolve ('${unresolvedName.name.text}')`, fix: "readable" };
  return NOT_BEFORE;
}
const REQUIRE = "A rule's require is { delegate, succeeded: true }: a delegation to an agent that succeeded";
const FILES = "A rule's unchangedSince is a non-empty list of file patterns";
const MAX_REDIRECT = 1000;
const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });
const hasControl = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
/** A requirement's agent matches exactly, case-sensitively: a run recorded under another spelling does not count (fail closed). */
const sameAgent = (a: AgentName, b: AgentName): boolean => a.value === b.value;
/**
 * A before rule's agent matches ignoring case and surrounding spaces: a host
 * may resolve another spelling to the same agent (Claude Code 2.1.294 runs
 * plan-reviewer for "Plan-Reviewer"), so the rule catches every one (fail closed).
 */
const anySpelling = (a: AgentName, b: AgentName): boolean => a.value.trim().toLowerCase() === b.value.trim().toLowerCase();

/** A rule's fields once checked and tidied. */
interface Fields {
  readonly before: Contract.PrerequisiteBefore;
  readonly require: { readonly delegate: AgentName; readonly succeeded: true };
  readonly unchangedSince: readonly [string, ...string[]];
  readonly redirect: string;
}

function beforeOf(raw: unknown): Result<Contract.PrerequisiteBefore> {
  if (hasExactly(raw, ["delegate"])) {
    const agent = AgentName.parse(own(raw, "delegate"));
    return agent.ok ? { ok: true, value: Object.freeze({ delegate: agent.value }) } : refuse(`A rule's before.delegate: ${agent.error}`);
  }
  if (hasExactly(raw, ["write"])) {
    const pattern = checkFilePattern(own(raw, "write"), "before.write");
    return pattern.ok ? { ok: true, value: Object.freeze({ write: pattern.value }) } : pattern;
  }
  if (hasExactly(raw, ["execute"])) {
    const prefix = ProgramPrefix.parse(own(raw, "execute"));
    return prefix.ok ? { ok: true, value: Object.freeze({ execute: prefix.value }) } : prefix;
  }
  return refuse(BEFORE);
}

function requireOf(raw: unknown): Result<Fields["require"]> {
  if (!hasExactly(raw, ["delegate", "succeeded"]) || own(raw, "succeeded") !== true) return refuse(REQUIRE);
  const agent = AgentName.parse(own(raw, "delegate"));
  return agent.ok ? { ok: true, value: Object.freeze({ delegate: agent.value, succeeded: true as const }) } : refuse(`A rule's require names no agent: ${agent.error}`);
}

function patternsOf(raw: unknown): Result<readonly [string, ...string[]]> {
  if (!Array.isArray(raw)) return refuse(FILES);
  const checked: string[] = [];
  for (const pattern of raw) {
    const tidy = checkFilePattern(pattern, "unchangedSince");
    if (!tidy.ok) return tidy;
    checked.push(tidy.value);
  }
  const [first, ...rest] = checked;
  return first === undefined ? refuse(FILES) : { ok: true, value: Object.freeze([first, ...rest] as const) };
}

function redirectOf(raw: unknown): Result<string> {
  if (typeof raw !== "string" || raw.trim() === "") return refuse("A rule's redirect must say what to do instead");
  const text = raw.trim();
  if (hasControl(text)) return refuse("A rule's redirect must not contain control characters");
  if (text.length > MAX_REDIRECT) return refuse(`A rule's redirect must be at most ${MAX_REDIRECT} characters`);
  return { ok: true, value: text };
}

function check(raw: unknown): Result<Fields> {
  if (!hasExactly(raw, ["before", "require", "unchangedSince", "redirect"])) return refuse(FORM);
  const before = beforeOf(own(raw, "before"));
  if (!before.ok) return before;
  const requirement = requireOf(own(raw, "require"));
  if (!requirement.ok) return requirement;
  if (before.value.delegate !== undefined && anySpelling(before.value.delegate, requirement.value.delegate)) {
    return refuse(`A rule cannot require the action it comes before: delegating to ${before.value.delegate.value}`);
  }
  const unchangedSince = patternsOf(own(raw, "unchangedSince"));
  if (!unchangedSince.ok) return unchangedSince;
  const redirect = redirectOf(own(raw, "redirect"));
  if (!redirect.ok) return redirect;
  return { ok: true, value: { before: before.value, require: requirement.value, unchangedSince: unchangedSince.value, redirect: redirect.value } };
}

class PrerequisiteRuleImpl implements Contract.PrerequisiteRule {
  declare readonly __brand: "PrerequisiteRule";
  declare readonly [prerequisiteRuleBrand]: true;
  readonly #made = true;
  readonly before: Contract.PrerequisiteBefore;
  readonly require: { readonly delegate: AgentName; readonly succeeded: true };
  readonly unchangedSince: readonly [string, ...string[]];
  readonly redirect: string;

  private constructor(fields: Fields) {
    this.before = fields.before;
    this.require = fields.require;
    this.unchangedSince = fields.unchangedSince;
    this.redirect = fields.redirect;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is PrerequisiteRuleImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.PrerequisiteRule> {
    return readSafely<Contract.PrerequisiteRule>("A prerequisite rule", () => {
      const fields = check(PrerequisiteRuleImpl.made(raw) ? wireFormOf(raw) : raw);
      return fields.ok ? { ok: true, value: new PrerequisiteRuleImpl(fields.value) } : fields;
    });
  }

  comesBefore(effect: Effect): boolean {
    return this.matchBefore(effect).kind === "comes-before";
  }

  matchBefore(effect: Effect): Contract.BeforeMatch {
    const { before } = this;
    if (before.delegate !== undefined) return effect.kind === "delegate" && anySpelling(effect.agent, before.delegate) ? { kind: "comes-before", what: describeEffect(effect) } : NOT_BEFORE;
    if (before.write !== undefined) {
      if (effect.kind === "write") return pathMatcherOf(before.write)(effect.path.value) ? { kind: "comes-before", what: describeEffect(effect) } : NOT_BEFORE;
      return effect.kind === "execute" ? writeMatch(before.write, effect) : NOT_BEFORE;
    }
    if (effect.kind !== "execute") return NOT_BEFORE;
    const match = before.execute.matchIn(effect.reading);
    if (match.kind === "runs") return { kind: "comes-before", what: `${describeEffect(effect)}, which runs '${before.execute.toJSON()}'` };
    return match.kind === "cannot-see" ? match : NOT_BEFORE;
  }

  requiredAgent(): AgentName {
    const { require: requirement } = this;
    return requirement.delegate;
  }

  requiresDelegationTo(agent: AgentName): boolean {
    return sameAgent(agent, this.requiredAgent());
  }

  mayResolveToRequiredAgent(requested: AgentName): boolean {
    return anySpelling(requested, this.requiredAgent());
  }

  requirementKey(): string {
    return requirementKeyOf(this.requiredAgent(), this.unchangedSince);
  }

  describeBefore(): string {
    const { before } = this;
    if (before.delegate !== undefined) return `before delegating to '${before.delegate.value}'`;
    if (before.write !== undefined) return `before write '${before.write}'`;
    return `before executing '${before.execute.toJSON()}'`;
  }

  status(records: readonly PrerequisiteRecord[], current: FileSetFingerprint, pendingRuns: readonly PendingAgentRun[] = []): Contract.PrerequisiteStatus {
    if (current.isEmpty()) return "missing";
    const key = this.requirementKey();
    const relevant = records.filter((record) => record.requirementKey() === key);
    if (relevant.some((record) => record.fingerprint.equals(current))) return "holds";
    if (this.pendingRun(pendingRuns, current) !== undefined) return "pending";
    return relevant.length === 0 ? "missing" : "stale";
  }

  pendingRun(pendingRuns: readonly PendingAgentRun[], current: FileSetFingerprint): PendingAgentRun | undefined {
    if (current.isEmpty()) return undefined;
    const key = this.requirementKey();
    return pendingRuns.find((run) => run.starts.some((start) => start.requirementKey() === key && start.fingerprint.equals(current)));
  }

  equals(other: Contract.PrerequisiteRule): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.PrerequisiteRuleJSON {
    const given = this.before;
    const before = given.delegate !== undefined ? { delegate: given.delegate.value } : given.write !== undefined ? { write: given.write } : { execute: given.execute.toJSON() };
    return { before, require: { delegate: this.requiredAgent().value, succeeded: true }, unchangedSince: this.unchangedSince, redirect: this.redirect };
  }
}

export type PrerequisiteRule = Contract.PrerequisiteRule;
export const PrerequisiteRule: Contract.PrerequisiteRuleFactory = PrerequisiteRuleImpl;

/**
 * The pack's point, as declared in its pack: prerequisite rules. The pack
 * ships none of its own: selected with no rules, it requires nothing.
 */
export const rulesPoint = point({
  description: "Prerequisite rules: an action that needs a delegation to an agent to have succeeded over files unchanged since, and what to do instead",
  check: PrerequisiteRule.parse,
  values: [],
});

/** The pack's rules in a composition: the point its pack made from rulesPoint, or undefined when it is not selected. */
export const rulesIn: Contract.RulesIn = (composition) => composition.pointDeclaredBy(rulesPoint);
