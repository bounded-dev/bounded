// The demonstration pack: one pack, exported as demo-package/demo.
export type { DemoPack, DemoPoints, DemoPorts } from "./demo.contract.ts";
export { demoPack } from "./demo.pack.ts";
export type { NoteFactory, NoteJSON } from "./domain/note.contract.ts";
export { Note } from "./domain/note.ts";
export type { NoteStore } from "./application/keep-notes.contract.ts";
