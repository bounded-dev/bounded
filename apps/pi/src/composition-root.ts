// The composition root: opens the project with the core's configuration
// feature. openProject never fails open (a configuration that cannot be used
// gives a judge refusing every event), and this root adds its own guard: if
// opening rejects, or the judge rejects or throws, every event is refused,
// with a reason and a redirect that reach pi as a block.
import { Verdict } from "bounded/domain";
import { openProject } from "bounded/open-project";
import type { Decide } from "./extension.ts";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Opens the project at `root` (absolute) and decides each event with its judge, which records every decision. */
export async function composeProject(root: string, open: typeof openProject = openProject): Promise<Decide> {
  let project: Awaited<ReturnType<typeof openProject>>;
  try {
    project = await open(root);
  } catch (error) {
    const refusal = Verdict.refuse(`bounded could not open the project: ${message(error)}`, "Fix the project's bounded setup, then start a new pi session");
    return async () => refusal;
  }
  return async (event): Promise<Verdict> => {
    try {
      return await project.judge(event);
    } catch (error) {
      return Verdict.refuse(`bounded could not judge this call: ${message(error)}`, "The call stays blocked until the failure is fixed; report it to the maintainers");
    }
  };
}
