import { portKeysFor } from "bounded/domain";
import { demoId } from "../domain/demo-id.ts";

/**
 * Where notes are kept between tool calls.
 * @implementedBy FileSystemNoteStore
 */
export interface NoteStore {
  /** Saves one note; rejects when it cannot be written. */
  save(text: string): Promise<void>;
}

/** The pack's store of notes. */
export const noteStorePort = portKeysFor(demoId)<NoteStore>("noteStore");
