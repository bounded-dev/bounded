import type { prerequisiteStatusSnapshotBrand } from "./prerequisite-status-snapshot.contract.ts";
import { AgentName, AgentRunId, DecisionTime, own, PackId, type Result, readSafely, sameWire, wireFormOf } from "bounded/domain";
import { checkFilePattern } from "./file-set.ts";
import type { PrerequisiteStatus } from "./prerequisite-rule.contract.ts";
import { beforeWireOf, parseBefore } from "./prerequisite-rule.ts";
import { hasExactly, requirementKeyOf } from "./prerequisite-start.ts";
import type * as Contract from "./prerequisite-status-snapshot.contract.ts";

const WHAT = "A prerequisite status snapshot";
const FORMAT: Contract.PrerequisiteStatusSnapshotFormat = "bounded-prereqs-status/1";
const FORM = `${WHAT} is { format, outcome, readingStartedAt, requirements, rules } when read, or { format, outcome, readingStartedAt, why } when unread`;
const READ_KEYS = ["format", "outcome", "readingStartedAt", "requirements", "rules"];
const UNREAD_KEYS = ["format", "outcome", "readingStartedAt", "why"];
const REQUIREMENT_KEYS = ["key", "requiredAgent", "unchangedSince", "status", "filesMatched", "pendingRun"];
const RULE_KEYS = ["contributedBy", "before", "requirementKey", "allows"];
const STATUSES: readonly PrerequisiteStatus[] = ["holds", "pending", "stale", "missing"];
const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isObject = (raw: unknown): raw is object => typeof raw === "object" && raw !== null && !Array.isArray(raw);
const isStatus = (raw: unknown): raw is PrerequisiteStatus => STATUSES.some((status) => status === raw);

function requirementOf(raw: unknown, at: string): Result<Contract.PrerequisiteRequirementStatusJSON> {
  if (!hasExactly(raw, REQUIREMENT_KEYS)) return refuse(`${at} is { key, requiredAgent, unchangedSince, status, filesMatched, pendingRun }`);
  const agent = AgentName.parse(own(raw, "requiredAgent"));
  if (!agent.ok) return refuse(`${at}'s requiredAgent: ${agent.error}`);
  const rawPatterns = own(raw, "unchangedSince");
  const patterns: string[] = [];
  for (const pattern of Array.isArray(rawPatterns) ? rawPatterns : []) {
    const tidy = checkFilePattern(pattern, "unchangedSince");
    if (!tidy.ok) return refuse(`${at}'s unchangedSince: ${tidy.error}`);
    patterns.push(tidy.value);
  }
  const [first, ...rest] = patterns;
  if (first === undefined) return refuse(`${at}'s unchangedSince: a non-empty list of file patterns`);
  const key = own(raw, "key");
  if (key !== requirementKeyOf(agent.value, patterns)) return refuse(`${at}'s key is not the key of its requiredAgent and unchangedSince`);
  const status = own(raw, "status");
  if (!isStatus(status)) return refuse(`${at}'s status is holds, pending, stale or missing`);
  const filesMatched = own(raw, "filesMatched");
  if (typeof filesMatched !== "number" || !Number.isSafeInteger(filesMatched) || filesMatched < 0) return refuse(`${at}'s filesMatched is a whole number, 0 or more`);
  if (filesMatched === 0 && status !== "missing") return refuse(`${at} matches no file, so its status is missing`);
  const rawRun = own(raw, "pendingRun");
  let pendingRun: Contract.PrerequisiteRequirementStatusJSON["pendingRun"] = null;
  if (rawRun !== null) {
    if (!hasExactly(rawRun, ["agentRunId", "startedAt"])) return refuse(`${at}'s pendingRun is null or { agentRunId, startedAt }`);
    const agentRunId = AgentRunId.parse(own(rawRun, "agentRunId"));
    if (!agentRunId.ok) return refuse(`${at}'s pendingRun.agentRunId: ${agentRunId.error}`);
    const startedAt = DecisionTime.parse(own(rawRun, "startedAt"));
    if (!startedAt.ok) return refuse(`${at}'s pendingRun.startedAt: ${startedAt.error}`);
    pendingRun = Object.freeze({ agentRunId: agentRunId.value.value, startedAt: startedAt.value.value });
  }
  if ((pendingRun !== null) !== (status === "pending")) return refuse(`${at} has a pendingRun exactly when its status is pending`);
  return { ok: true, value: Object.freeze({ key, requiredAgent: agent.value.value, unchangedSince: Object.freeze([first, ...rest] as const), status, filesMatched, pendingRun }) };
}

function ruleOf(raw: unknown, at: string, requirements: readonly Contract.PrerequisiteRequirementStatusJSON[]): Result<Contract.PrerequisiteRuleStatusJSON> {
  if (!hasExactly(raw, RULE_KEYS)) return refuse(`${at} is { contributedBy, before, requirementKey, allows }`);
  const contributedBy = PackId.parse(own(raw, "contributedBy"));
  if (!contributedBy.ok) return refuse(`${at}'s contributedBy: ${contributedBy.error}`);
  const before = parseBefore(own(raw, "before"));
  if (!before.ok) return refuse(`${at}'s before: ${before.error}`);
  const requirementKey = own(raw, "requirementKey");
  const requirement = requirements.find((listed) => listed.key === requirementKey);
  if (requirement === undefined) return refuse(`${at}'s requirementKey names no requirement in the snapshot`);
  const allows = own(raw, "allows");
  if (typeof allows !== "boolean") return refuse(`${at}'s allows is true or false`);
  if (allows !== (requirement.status === "holds")) return refuse(`${at} allows exactly when its requirement holds`);
  return { ok: true, value: Object.freeze({ contributedBy: contributedBy.value.value, before: Object.freeze(beforeWireOf(before.value)), requirementKey: requirement.key, allows }) };
}

function check(raw: unknown): Result<Contract.PrerequisiteStatusSnapshotJSON> {
  if (!isObject(raw) || !(hasExactly(raw, READ_KEYS) || hasExactly(raw, UNREAD_KEYS))) return refuse(FORM);
  if (own(raw, "format") !== FORMAT) return refuse(`${WHAT}'s format is "${FORMAT}"`);
  const outcome = own(raw, "outcome");
  if (outcome !== "read" && outcome !== "unread") return refuse(`${WHAT}'s outcome is "read" or "unread"`);
  if (!hasExactly(raw, outcome === "read" ? READ_KEYS : UNREAD_KEYS)) return refuse(FORM);
  const readingStartedAt = DecisionTime.parse(own(raw, "readingStartedAt"));
  if (!readingStartedAt.ok) return refuse(`${WHAT}'s readingStartedAt: ${readingStartedAt.error}`);
  if (outcome === "unread") {
    const why = own(raw, "why");
    if (typeof why !== "string" || why.trim() === "") return refuse(`${WHAT}'s why says why the status could not be read`);
    return { ok: true, value: Object.freeze({ format: FORMAT, outcome, readingStartedAt: readingStartedAt.value.value, why }) };
  }
  const rawRequirements = own(raw, "requirements");
  if (!Array.isArray(rawRequirements)) return refuse(`${WHAT}'s requirements are a list of requirements`);
  const requirements: Contract.PrerequisiteRequirementStatusJSON[] = [];
  for (const [index, item] of rawRequirements.entries()) {
    const requirement = requirementOf(item, `${WHAT}'s requirement ${index + 1}`);
    if (!requirement.ok) return requirement;
    const earlier = requirements.findIndex((listed) => listed.key === requirement.value.key);
    if (earlier !== -1) return refuse(`${WHAT}'s requirement ${index + 1} repeats the key of requirement ${earlier + 1}: list each requirement once`);
    requirements.push(requirement.value);
  }
  const rawRules = own(raw, "rules");
  if (!Array.isArray(rawRules)) return refuse(`${WHAT}'s rules are a list of rules`);
  const rules: Contract.PrerequisiteRuleStatusJSON[] = [];
  for (const [index, item] of rawRules.entries()) {
    const rule = ruleOf(item, `${WHAT}'s rule ${index + 1}`, requirements);
    if (!rule.ok) return rule;
    rules.push(rule.value);
  }
  return { ok: true, value: Object.freeze({ format: FORMAT, outcome, readingStartedAt: readingStartedAt.value.value, requirements: Object.freeze(requirements), rules: Object.freeze(rules) }) };
}

class PrerequisiteStatusSnapshotImpl implements Contract.PrerequisiteStatusSnapshot {
  declare readonly __brand: "PrerequisiteStatusSnapshot";
  declare readonly [prerequisiteStatusSnapshotBrand]: true;
  readonly #made = true;
  readonly outcome: "read" | "unread";
  readonly readingStartedAt: DecisionTime;
  /** The wire form, checked and frozen: toJSON gives it as it is. */
  readonly #wire: Contract.PrerequisiteStatusSnapshotJSON;

  private constructor(wire: Contract.PrerequisiteStatusSnapshotJSON, readingStartedAt: DecisionTime) {
    this.#wire = wire;
    this.outcome = wire.outcome;
    this.readingStartedAt = readingStartedAt;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is PrerequisiteStatusSnapshotImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.PrerequisiteStatusSnapshot> {
    return readSafely<Contract.PrerequisiteStatusSnapshot>(WHAT, () => {
      const wire = check(PrerequisiteStatusSnapshotImpl.made(raw) ? wireFormOf(raw) : raw);
      if (!wire.ok) return wire;
      const readingStartedAt = DecisionTime.parse(wire.value.readingStartedAt);
      return readingStartedAt.ok ? { ok: true, value: new PrerequisiteStatusSnapshotImpl(wire.value, readingStartedAt.value) } : readingStartedAt;
    });
  }

  equals(other: Contract.PrerequisiteStatusSnapshot): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.PrerequisiteStatusSnapshotJSON {
    return this.#wire;
  }
}

export type PrerequisiteStatusSnapshot = Contract.PrerequisiteStatusSnapshot;
export const PrerequisiteStatusSnapshot: Contract.PrerequisiteStatusSnapshotFactory = PrerequisiteStatusSnapshotImpl;
