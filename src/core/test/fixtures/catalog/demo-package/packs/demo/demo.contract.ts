import type { BasePack, ExtensionPoint, PortKey } from "bounded/domain";
import type { NoteStore } from "./application/keep-notes.contract.ts";
import type { DemoId } from "./domain/demo-id.ts";
import type { Note } from "./domain/note.contract.ts";

/** The demonstration pack's points. */
export type DemoPoints = {
  /** Notes: one line of text each, kept by the project for its agents. */
  readonly notes: ExtensionPoint<Note, DemoId>;
};

/** The adapters the demonstration pack needs a host to provide. */
export type DemoPorts = {
  readonly noteStore: PortKey<NoteStore, DemoId>;
};

/** The demonstration pack: its id, its points and its ports. */
export interface DemoPack extends BasePack {
  readonly id: DemoId;
  readonly points: DemoPoints;
  readonly ports: DemoPorts;
}
