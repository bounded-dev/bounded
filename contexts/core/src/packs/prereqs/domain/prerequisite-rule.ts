import type { prerequisiteRuleBrand } from "./prerequisite-rule.contract.ts";
import { AgentName, type Effect, own, point, type Result, readSafely, sameWire, wireFormOf } from "bounded/domain";
import { checkFilePattern, pathMatcherOf } from "./file-set.ts";
import type { FileSetFingerprint } from "./file-set-fingerprint.contract.ts";
import type { PrerequisiteRecord } from "./prerequisite-record.contract.ts";
import type * as Contract from "./prerequisite-rule.contract.ts";
import { hasExactly, requirementKeyOf } from "./prerequisite-start.ts";

const FORM = "A prerequisite rule is { before, require, unchangedSince, redirect }";
const BEFORE = "A rule's before names one action: { delegate: <agent> } or { write: <pattern> } (execute is not matched yet)";
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
    if (this.before.delegate !== undefined) return effect.kind === "delegate" && anySpelling(effect.agent, this.before.delegate);
    return effect.kind === "write" && pathMatcherOf(this.before.write)(effect.path.value);
  }

  requiredAgent(): AgentName {
    const { require: requirement } = this;
    return requirement.delegate;
  }

  requiresDelegationTo(agent: AgentName): boolean {
    return sameAgent(agent, this.requiredAgent());
  }

  requirementKey(): string {
    return requirementKeyOf(this.requiredAgent(), this.unchangedSince);
  }

  describeBefore(): string {
    return this.before.delegate !== undefined ? `before delegating to '${this.before.delegate.value}'` : `before write '${this.before.write}'`;
  }

  status(records: readonly PrerequisiteRecord[], current: FileSetFingerprint): Contract.PrerequisiteStatus {
    if (current.isEmpty()) return "missing";
    const key = this.requirementKey();
    const relevant = records.filter((record) => record.requirementKey() === key);
    if (relevant.length === 0) return "missing";
    return relevant.some((record) => record.fingerprint.equals(current)) ? "holds" : "stale";
  }

  equals(other: Contract.PrerequisiteRule): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.PrerequisiteRuleJSON {
    const before = this.before.delegate !== undefined ? { delegate: this.before.delegate.value } : { write: this.before.write };
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
