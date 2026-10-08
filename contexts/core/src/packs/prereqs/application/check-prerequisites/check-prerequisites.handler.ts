import { type AfterToolReport, type Composition, type DelegateEffect, describeEffect, type Effect, type Entry, type Result, type ToolResult, type ToolUse, Verdict } from "bounded/domain";
import { FileSetFingerprint } from "../../domain/file-set-fingerprint.ts";
import { PrerequisiteRecord } from "../../domain/prerequisite-record.ts";
import type { PrerequisiteRule } from "../../domain/prerequisite-rule.contract.ts";
import { rulesIn } from "../../domain/prerequisite-rule.ts";
import { PrerequisiteStart } from "../../domain/prerequisite-start.ts";
import type { CheckPrerequisites, FileSetFingerprints, PrerequisiteRecords } from "./check-prerequisites.contract.ts";

/** Every refusal and message begins with the pack's point. */
const PREFIX = "bounded/prereqs.rules:";
const UNREADABLE_FILES = "Fix what stops the project's files from being read; until then actions that need a prerequisite are refused";
const UNREADABLE_RECORDS = "Fix what stops bounded/prereqs's records from being read; until then actions that need a prerequisite are refused";
const HOST = "Report this to the maintainers of the host adapter; the delegation is refused meanwhile";
const NOTHING_TO_REPORT = (): AfterToolReport => ({ message: null, record: null });

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

const listed = (patterns: readonly string[]): string => patterns.map((pattern) => `'${pattern}'`).join(", ");
const isDelegation = (effect: Effect): effect is DelegateEffect => effect.kind === "delegate";

/** A rule and the pack that contributed it. */
type Rule = Entry<PrerequisiteRule>;

/** How a message names a rule: "<pack>'s rule before …, requiring <agent> to have succeeded over <files>". */
const named = ({ fromPackId, value: rule }: Rule): string =>
  `${fromPackId.value}'s rule ${rule.describeBefore()} requires a delegation to ${rule.requiredAgent().value} that succeeded over the current ${listed(rule.unchangedSince)}`;

/** What one delegation's result came to: a message for the agent, and what to record, if anything. */
interface Outcome {
  readonly message: string | null;
  readonly record: AfterToolReport["record"];
}

/**
 * Checks prerequisites around tool calls. Before a call, each rule that comes
 * before one of its effects must hold: a record of its required delegation
 * whose fingerprint equals its files' fingerprint now. A delegation some rule
 * requires must be one whose finish the host reports, on the project's own
 * files, with a call id; its files are fingerprinted and kept by call id.
 * After it, a run the host says finished, that succeeded, over files whose
 * fingerprint did not change while it ran, is recorded. Everything kept
 * outside the process is parsed before it is trusted, and anything that
 * cannot be read or computed refuses.
 */
export class CheckPrerequisitesHandler implements CheckPrerequisites {
  constructor(
    private readonly composition: Composition,
    private readonly fingerprints: FileSetFingerprints,
    private readonly records: PrerequisiteRecords,
  ) {}

  async before(call: ToolUse): Promise<Verdict> {
    try {
      const rules = this.rules();
      if (!rules.ok) return Verdict.refuse(`${PREFIX} the rules cannot be read: ${rules.error}`, "Select bounded/prereqs once, with the core pack");
      const gated = rules.value.flatMap((rule) => call.effects.filter((effect) => rule.value.comesBefore(effect)).map((effect) => ({ rule, effect })));
      const delegations = call.effects.filter(isDelegation).filter((effect) => this.requiring(rules.value, effect).length > 0);
      if (gated.length === 0 && delegations.length === 0) return Verdict.allow;

      for (const delegation of delegations) {
        const agent = delegation.agent.value;
        const [first] = this.requiring(rules.value, delegation);
        const rule = first === undefined ? "" : `${first.fromPackId.value}'s rule ${first.value.describeBefore()} needs ${agent}'s runs`;
        if (delegation.isolated === true) {
          return Verdict.refuse(`${PREFIX} ${rule} over the project's own files, and this delegation runs ${agent} isolated, on a separate copy of them`, `Run ${agent} without isolation, on the project's own files`);
        }
        if (delegation.finishUnreported === true) {
          return Verdict.refuse(`${PREFIX} ${rule} to be seen finishing, and the host will not report when this run of ${agent} finishes`, `Run ${agent} as a run whose finish the host reports (not as a teammate or an asynchronous run)`);
        }
        if (call.callId === undefined) return Verdict.refuse(`${PREFIX} this delegation to ${agent} has no call id, so its result could not be paired with it`, HOST);
      }

      if (gated.length > 0) {
        const records = await this.recorded();
        if (!records.ok) return Verdict.refuse(`${PREFIX} the prerequisites recorded so far could not be read: ${records.error}`, UNREADABLE_RECORDS);
        for (const { rule, effect } of gated) {
          const now = await this.fingerprint(rule.value.unchangedSince);
          if (!now.ok) return Verdict.refuse(`${PREFIX} the files of ${named(rule)} could not be fingerprinted: ${now.error}`, UNREADABLE_FILES);
          const status = rule.value.status(records.value, now.value);
          if (status === "holds") continue;
          const why = now.value.isEmpty()
            ? "those patterns match no file, so it can never be met"
            : status === "stale"
              ? `${rule.value.requiredAgent().value} succeeded over them, but they have changed since`
              : `${rule.value.requiredAgent().value} has not succeeded over them`;
          return Verdict.refuse(`${PREFIX} ${named(rule)}, and ${why}. This call would ${describeEffect(effect)}`, rule.value.redirect);
        }
      }

      const callId = call.callId;
      if (delegations.length === 0 || callId === undefined) return Verdict.allow;
      const starts: PrerequisiteStart[] = [];
      const kept = new Set<string>();
      for (const delegation of delegations) {
        for (const rule of this.requiring(rules.value, delegation)) {
          const key = rule.value.requirementKey();
          if (kept.has(key)) continue;
          kept.add(key);
          const now = await this.fingerprint(rule.value.unchangedSince);
          if (!now.ok) return Verdict.refuse(`${PREFIX} the files of ${named(rule)} could not be fingerprinted before ${delegation.agent.value} runs: ${now.error}`, UNREADABLE_FILES);
          if (now.value.isEmpty()) return Verdict.refuse(`${PREFIX} ${named(rule)}, and those patterns match no file, so a run of ${delegation.agent.value} can never meet it`, rule.value.redirect);
          const start = PrerequisiteStart.parse({ delegate: delegation.agent.value, unchangedSince: rule.value.unchangedSince, fingerprint: now.value.toJSON() });
          if (!start.ok) return Verdict.refuse(`${PREFIX} the start of ${delegation.agent.value}'s run could not be made: ${start.error}`, UNREADABLE_FILES);
          starts.push(start.value);
        }
      }
      try {
        await this.records.saveStartedForCall(callId, starts);
      } catch (thrown) {
        return Verdict.refuse(`${PREFIX} the start of this delegation could not be kept: ${text(thrown)}`, UNREADABLE_RECORDS);
      }
      return Verdict.allow;
    } catch (thrown) {
      return Verdict.refuse(`${PREFIX} prerequisites could not be checked before this call: ${text(thrown)}`, UNREADABLE_RECORDS);
    }
  }

  async after(result: ToolResult): Promise<AfterToolReport> {
    const delegations = result.effects.filter(isDelegation);
    try {
      const rules = this.rules();
      if (!rules.ok) return refused(`${PREFIX} the rules cannot be read, so no delegation is recorded: ${rules.error}`, delegations[0] ?? null);
      const required = delegations.flatMap((effect, index) => (this.requiring(rules.value, effect).length > 0 ? [{ effect, index }] : []));
      const [firstRequired] = required;
      if (firstRequired === undefined) return NOTHING_TO_REPORT();
      if (result.callId === undefined) return refused(`${PREFIX} this delegation's result has no call id, so it cannot be paired with its start and is not recorded`, firstRequired.effect);
      const callId = result.callId;
      let stored: unknown;
      try {
        stored = await this.records.takeStartedForCall(callId);
      } catch (thrown) {
        return refused(`${PREFIX} the start kept for this delegation could not be read (${text(thrown)}), so it is not recorded; run ${firstRequired.effect.agent.value} again`, firstRequired.effect);
      }
      const starts = stored === undefined ? undefined : PrerequisiteStart.parseList(stored);
      if (starts !== undefined && !starts.ok) {
        return refused(`${PREFIX} the start kept for this delegation was altered (${starts.error}), so it is not recorded; run ${firstRequired.effect.agent.value} again`, firstRequired.effect);
      }
      const outcomes: Outcome[] = [];
      for (const { effect, index } of required) {
        const agent = effect.agent.value;
        const finished = result.delegatedAgentRuns?.[index]?.finished === true && effect.isolated !== true && effect.finishUnreported !== true;
        if (result.delegatedAgentRuns?.[index]?.finishNeverReported === true) {
          // No re-run can help: say so plainly instead of asking for one.
          outcomes.push(told(`${PREFIX} this host does not report when ${agent} finishes, so ${agent}'s run cannot meet this requirement yet; nothing is recorded`));
        } else if (!result.ok) outcomes.push(told(`${PREFIX} ${agent}'s run did not succeed, so it is not recorded`));
        else if (!finished) outcomes.push(told(`${PREFIX} ${agent}'s run was not seen to finish (it may still be running in the background), so it is not recorded; run ${agent} so that the host reports its finish`));
        else if (starts === undefined) outcomes.push(told(`${PREFIX} no start was kept for ${agent}'s run (the call was not seen before it ran, or its start expired), so it is not recorded; run ${agent} again`));
        else outcomes.push(...(await this.recordRun(rules.value, effect, starts.value, callId)));
      }
      return combined(outcomes);
    } catch (thrown) {
      return refused(`${PREFIX} prerequisites could not be recorded after this call: ${text(thrown)}`, delegations[0] ?? null);
    }
  }

  /** Records a finished, successful run once for each requirement it meets, when its files did not change while it ran. */
  private async recordRun(rules: readonly Rule[], effect: DelegateEffect, starts: readonly PrerequisiteStart[], callId: NonNullable<ToolResult["callId"]>): Promise<Outcome[]> {
    const agent = effect.agent.value;
    const outcomes: Outcome[] = [];
    const done = new Set<string>();
    for (const rule of this.requiring(rules, effect)) {
      const key = rule.value.requirementKey();
      if (done.has(key)) continue;
      done.add(key);
      const files = listed(rule.value.unchangedSince);
      const start = starts.find((kept) => kept.requirementKey() === key);
      if (start === undefined) {
        outcomes.push(told(`${PREFIX} no start was kept for ${agent}'s run over ${files}, so it is not recorded for them; run ${agent} again`));
        continue;
      }
      const now = await this.fingerprint(rule.value.unchangedSince);
      if (!now.ok) {
        outcomes.push(refused(`${PREFIX} the files ${files} could not be fingerprinted after ${agent}'s run (${now.error}), so it is not recorded`, effect));
        continue;
      }
      if (now.value.isEmpty()) {
        outcomes.push(told(`${PREFIX} ${files} match no file, so ${agent}'s run over them is not recorded: the requirement can never be met`));
        continue;
      }
      if (!now.value.equals(start.fingerprint)) {
        outcomes.push(told(`${PREFIX} the files ${files} changed while ${agent} ran, so its run is not recorded; run ${agent} again over the files as they are`));
        continue;
      }
      const record = PrerequisiteRecord.parse({ ...start.toJSON(), callId: callId.value });
      if (!record.ok) {
        outcomes.push(refused(`${PREFIX} ${agent}'s run could not be recorded: ${record.error}`, effect));
        continue;
      }
      try {
        await this.records.append(record.value);
        outcomes.push({ message: null, record: { verdict: Verdict.allow, refusedBy: null, note: `${agent}'s run recorded as a prerequisite over ${files}` } });
      } catch (thrown) {
        outcomes.push(refused(`${PREFIX} ${agent}'s run could not be recorded (${text(thrown)}); run ${agent} again once bounded/prereqs's records can be written`, effect));
      }
    }
    return outcomes;
  }

  /** The composed rules, with the packs that contributed them, in contribution order. */
  private rules(): Result<readonly Rule[]> {
    const point = rulesIn(this.composition);
    if (point === undefined) return { ok: false, error: "bounded/prereqs is not selected" };
    return this.composition.entries(point);
  }

  /** The rules whose requirement is a delegation to `effect`'s agent. */
  private requiring(rules: readonly Rule[], effect: DelegateEffect): readonly Rule[] {
    return rules.filter((rule) => rule.value.requiresDelegationTo(effect.agent));
  }

  /** Every record, each parsed: one that is not a record makes them all unreadable. */
  private async recorded(): Promise<Result<readonly PrerequisiteRecord[]>> {
    let stored: readonly unknown[];
    try {
      stored = await this.records.readAll();
    } catch (thrown) {
      return { ok: false, error: text(thrown) };
    }
    const records: PrerequisiteRecord[] = [];
    for (const [index, raw] of stored.entries()) {
      const record = PrerequisiteRecord.parse(raw);
      if (!record.ok) return { ok: false, error: `record ${index + 1} is not one: ${record.error}` };
      records.push(record.value);
    }
    return { ok: true, value: records };
  }

  /** The current fingerprint of `patterns`, parsed, or why it cannot be had. */
  private async fingerprint(patterns: readonly string[]): Promise<Result<FileSetFingerprint>> {
    try {
      const given = await this.fingerprints.fingerprint(patterns);
      return given.ok ? FileSetFingerprint.parse(given.value) : given;
    } catch (thrown) {
      return { ok: false, error: text(thrown) };
    }
  }
}

/** An outcome that only tells the agent. */
const told = (message: string): Outcome => ({ message, record: null });

/** An outcome told to the agent and recorded as a refusal by the pack, on `effect`. */
function refused(message: string, effect: DelegateEffect | null): Outcome {
  return { message, record: { verdict: Verdict.refuse(message, "Run the agent again so that its run is recorded"), refusedBy: { effect }, note: "a prerequisite could not be recorded" } };
}

/** The outcomes of one result as one report: the messages joined; the first refusal recorded, else the first record. */
function combined(outcomes: readonly Outcome[]): AfterToolReport {
  const messages = outcomes.flatMap((outcome) => (outcome.message === null ? [] : [outcome.message]));
  const records = outcomes.flatMap((outcome) => (outcome.record === null ? [] : [outcome.record]));
  const record = records.find((given) => given.verdict.kind === "refuse") ?? records[0] ?? null;
  return { message: messages.length === 0 ? null : messages.join("\n"), record };
}
