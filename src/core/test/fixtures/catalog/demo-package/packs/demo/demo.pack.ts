import { contribution, corePack, definePack } from "bounded/domain";
import { noteStorePort } from "./application/keep-notes.contract.ts";
import { allowEveryCall } from "./application/keep-notes.lifecycle.ts";
import { demoId } from "./domain/demo-id.ts";
import { notesPoint } from "./domain/note.ts";
import type { DemoPack } from "./demo.contract.ts";

/**
 * The demonstration pack, `demo-package/demo`: projects contribute notes to
 * `notes`, and its check before each tool call allows it.
 */
export const demoPack: DemoPack = definePack({
  id: demoId,
  dependsOn: [corePack],
  points: { notes: notesPoint },
  contributes: [contribution(corePack.points.beforeTool, [allowEveryCall])],
  ports: { noteStore: noteStorePort },
});
