// bounded-pi: the pi host adapter for bounded.
import { composeProject } from "./composition-root.ts";
import { type ExtensionOptions, type Pi, piExtension } from "./extension.ts";

export type { Effect, ToolUse } from "./event.ts";
export type { Decide, ExtensionOptions, Load, Pi, PiBlock, PiHandler } from "./extension.ts";
export { piExtension } from "./extension.ts";
export { type ProjectFile, piLoader } from "./install.ts";
export { type Locate, type Located, locator, piRewrite } from "./pi-path.ts";
export { type PiToolCall, translate } from "./translate.ts";

/** Timings a project may change: composing (15 s), each decision (3 s), and the back-off after composing times out (30 s). */
export type BoundedOptions = Pick<ExtensionOptions, "deadlineMs" | "composeDeadlineMs" | "composeBackoffMs">;

/** The extension for the project at `root`, composed from its configuration. What the generated loader hands the project to. */
export function bounded(root: string, options: BoundedOptions = {}): (pi: Pi) => void {
  return piExtension({ ...options, root, load: () => composeProject(root) });
}
