import type { BasePack, ExtensionPoint, PortKey } from "bounded/domain";
import type { FileSetFingerprints, PrerequisiteRecords, PrerequisiteStatusSnapshots } from "./application/check-prerequisites/check-prerequisites.contract.ts";
import type { PrereqsId } from "./domain/prereqs-id.contract.ts";
import type { PrerequisiteRule } from "./domain/prerequisite-rule.contract.ts";

export type { PrereqsId } from "./domain/prereqs-id.contract.ts";

// The prerequisites pack, `bounded/prereqs`: every way a pack or project plugs
// into it. prereqs is typed by this contract, so its definition must match.

/** The pack's points (a type, not an interface, so it is a record of points as composition reads packs). */
export type PrereqsPoints = {
  /** Prerequisite rules: an action that needs a delegation to an agent to have succeeded over files unchanged since, and what to do instead. */
  readonly rules: ExtensionPoint<PrerequisiteRule, PrereqsId>;
};

/** The adapters the pack needs a host to provide through openProject({ ports }). */
export type PrereqsPorts = {
  readonly fileSetFingerprints: PortKey<FileSetFingerprints, PrereqsId>;
  readonly prerequisiteRecords: PortKey<PrerequisiteRecords, PrereqsId>;
};

/** The adapters a host may provide (ADR 2026-026): the status snapshot, for a host that shows the pack's status. Every verdict and record is the same without them. */
export type PrereqsOptionalPorts = {
  readonly prerequisiteStatusSnapshots: PortKey<PrerequisiteStatusSnapshots, PrereqsId>;
};

/** The prerequisites pack: its id, its points, its ports and its optional ports. */
export interface Prereqs extends BasePack {
  readonly id: PrereqsId;
  readonly points: PrereqsPoints;
  readonly ports: PrereqsPorts;
  readonly optionalPorts: PrereqsOptionalPorts;
}
