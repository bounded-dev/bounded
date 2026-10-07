// Contracts are exported as types. Commands are exported from their implementation file (type and value together).
export type {
  ComposePacks,
  ComposePacksCatalog,
  ComposePacksCommandFactory,
  ComposePacksInput,
} from "./composition/compose-packs/compose-packs.contract.ts";
export { ComposePacksCommand } from "./composition/compose-packs/compose-packs.command.ts";
export { ComposePacksHandler } from "./composition/compose-packs/compose-packs.handler.ts";

export type { AdapterRefusalInput, Clock, DecisionIds, DecisionLog, JudgeEvent, JudgeEventCommandFactory, JudgeEventInput } from "./judging/judge-event/judge-event.contract.ts";
export { JudgeEventCommand } from "./judging/judge-event/judge-event.command.ts";
export { JudgeEventHandler } from "./judging/judge-event/judge-event.handler.ts";

export type { OpenProject, OpenProjectCommandFactory, OpenProjectInput, ProjectConfigSource, ProjectDecisionLogs, ProjectDrift, ProjectJudge } from "./projects/open-project/open-project.contract.ts";
export type { Change, DriftCheck, Kept, RestoreFrom, ShellSnapshots, Snapshot, SnapshotFile, WatchedFile, WatchedFiles, WatchedHashes, WatchShell } from "./drift/watch-shell/watch-shell.contract.ts";
export { WatchShellHandler } from "./drift/watch-shell/watch-shell.handler.ts";
export { OpenProjectCommand } from "./projects/open-project/open-project.command.ts";
export { OpenProjectHandler } from "./projects/open-project/open-project.handler.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
