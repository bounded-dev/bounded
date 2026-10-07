// The composition root: opens the project with the core's configuration
// feature. openProject never fails open: a configuration that cannot be used
// gives a judge that refuses every event, which the extension turns into a
// block with the core's reason and redirect.
import { openProject } from "bounded/open-project";
import type { Decide } from "./extension.ts";

/** Opens the project at `root` (absolute) and decides each event with its judge, which records every decision. */
export async function composeProject(root: string): Promise<Decide> {
  const project = await openProject(root);
  return (event) => project.judge(event);
}
