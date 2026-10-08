import type { prerequisiteRecordBrand } from "./prerequisite-record.contract.ts";
import { type AgentName, CallId, own, type Result, readSafely, sameWire, wireFormOf } from "bounded/domain";
import type { FileSetFingerprint } from "./file-set-fingerprint.contract.ts";
import type * as Contract from "./prerequisite-record.contract.ts";
import { hasExactly, parseRequirementFields, type RequirementFields, requirementKeyOf } from "./prerequisite-start.ts";

const KEYS = ["delegate", "unchangedSince", "fingerprint", "callId"];
const FORM = "A prerequisite record is { delegate, unchangedSince, fingerprint, callId }";
const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

class PrerequisiteRecordImpl implements Contract.PrerequisiteRecord {
  declare readonly __brand: "PrerequisiteRecord";
  declare readonly [prerequisiteRecordBrand]: true;
  readonly #made = true;
  readonly delegate: AgentName;
  readonly unchangedSince: readonly [string, ...string[]];
  readonly fingerprint: FileSetFingerprint;

  private constructor(
    fields: RequirementFields,
    readonly callId: CallId,
  ) {
    this.delegate = fields.delegate;
    this.unchangedSince = fields.unchangedSince;
    this.fingerprint = fields.fingerprint;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is PrerequisiteRecordImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.PrerequisiteRecord> {
    return readSafely<Contract.PrerequisiteRecord>("A prerequisite record", () => {
      const given = PrerequisiteRecordImpl.made(raw) ? wireFormOf(raw) : raw;
      if (!hasExactly(given, KEYS)) return refuse(FORM);
      const fields = parseRequirementFields(given, "A prerequisite record");
      if (!fields.ok) return fields;
      const callId = CallId.parse(own(given, "callId"));
      if (!callId.ok) return refuse(`A prerequisite record's callId: ${callId.error}`);
      return { ok: true, value: new PrerequisiteRecordImpl(fields.value, callId.value) };
    });
  }

  requirementKey(): string {
    return requirementKeyOf(this.delegate, this.unchangedSince);
  }

  equals(other: Contract.PrerequisiteRecord): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.PrerequisiteRecordJSON {
    return { delegate: this.delegate.value, unchangedSince: this.unchangedSince, fingerprint: this.fingerprint.toJSON(), callId: this.callId.value };
  }
}

export type PrerequisiteRecord = Contract.PrerequisiteRecord;
export const PrerequisiteRecord: Contract.PrerequisiteRecordFactory = PrerequisiteRecordImpl;
