import type { Result } from "bounded/domain";
import { loadInstallers, runInstallers } from "../init-project/init-project.handler.ts";
import type { HostInstallerSource, ProjectSetupFiles, SetupReport, UpdateProject } from "./update-project.contract.ts";

/** Whether `projectRoot` was set up: it has exactly one configuration. */
export async function requireInitialised(files: ProjectSetupFiles, projectRoot: string): Promise<Result<string>> {
  const present = await files.configFileNames(projectRoot);
  if (!present.ok) return present;
  if (present.value.length === 0) return { ok: false, error: `${projectRoot} has no bounded configuration, so bounded was never set up here: run \`bounded init\` first` };
  const [only] = present.value;
  if (present.value.length > 1 || only === undefined) return { ok: false, error: `${projectRoot} has more than one configuration (${present.value.join(", ")}): keep one, then run \`bounded update\` again` };
  return { ok: true, value: only };
}

export class UpdateProjectHandler implements UpdateProject {
  constructor(
    private readonly files: ProjectSetupFiles,
    private readonly installers: HostInstallerSource,
  ) {}

  async execute(projectRoot: string): Promise<Result<SetupReport>> {
    const initialised = await requireInitialised(this.files, projectRoot);
    if (!initialised.ok) return initialised;
    const installers = await loadInstallers(this.installers, projectRoot);
    if (!installers.ok) return installers;
    const hosts = await runInstallers(installers.value, projectRoot);
    if (!hosts.ok) return hosts;
    return { ok: true, value: { configWritten: null, hosts: hosts.value } };
  }
}
