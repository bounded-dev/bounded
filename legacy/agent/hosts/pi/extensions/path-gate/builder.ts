/**
 * Per-role path-gate loader — builder.
 *
 * NOT auto-discovered (subdirectory without index.ts). A pipeline agent loads
 * it explicitly via frontmatter `subagentOnlyExtensions`, binding the role for
 * that agent's child process only. See ../path-gate.ts for the design.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installPathGate } from "../path-gate.ts";

export default function (pi: ExtensionAPI): void {
  installPathGate(pi, "builder");
}
