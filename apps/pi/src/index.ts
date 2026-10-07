// bounded-pi: the pi host adapter for bounded.
import { composeProject } from "./composition-root.ts";
import { type Pi, piExtension } from "./extension.ts";

export type { Effect, ToolUse } from "./event.ts";
export type { Decide, ExtensionOptions, Load, Pi, PiBlock, PiHandler } from "./extension.ts";
export { piExtension } from "./extension.ts";
export { type ProjectFile, piLoader } from "./install.ts";
export { type Locate, type Located, locator, piRewrite } from "./pi-path.ts";
export { type PiToolCall, translate } from "./translate.ts";

/** The extension for the project at `root`, composed from its configuration. What the generated loader default-exports. */
export function bounded(root: string): (pi: Pi) => void {
  return piExtension({ root, load: () => composeProject(root) });
}
