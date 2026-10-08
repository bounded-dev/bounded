// The tracker adapters the harness ships, by the `kind` an installation's
// tracker config names (src/tracker.ts). Entry points open the tracker here
// and hand it to the core, which only ever sees the port.

import { readTrackerConfig, TrackerError, type Tracker } from "../src/tracker.ts";
import { ghCommandLine, GITHUB_KIND, gitHubSettings, gitHubTracker, resolveGitHubAtInit } from "./github.ts";

/** The tracker an installation records, or a TrackerError saying why there is none. */
export function openTracker(cwd: string): Tracker {
  const config = readTrackerConfig(cwd);
  if ("error" in config) throw new TrackerError(config.error);
  if (config.kind === GITHUB_KIND) return gitHubTracker(gitHubSettings(config.settings), ghCommandLine());
  throw new TrackerError(`tracker kind '${config.kind}' has no adapter in this harness`);
}

/** The tracker config init writes, after checking the required tracker is
 *  reachable and set up. The harness requires GitHub (ADR LEG-2026-066). */
export function trackerConfigAtInit(target: string, options: { readonly project?: string; readonly createStatuses?: boolean } = {}): string {
  const config = resolveGitHubAtInit(target, options.project ?? recordedProject(target), ghCommandLine(),
    options.createStatuses === true ? { createStatuses: true } : {});
  return JSON.stringify(config, null, 2) + "\n";
}

/** A re-plan keeps the board the installation already records. */
function recordedProject(target: string): string | undefined {
  const config = readTrackerConfig(target);
  if ("error" in config || config.kind !== GITHUB_KIND) return undefined;
  try {
    const { project } = gitHubSettings(config.settings);
    return `${project.owner}/${project.number}`;
  } catch {
    return undefined;
  }
}
