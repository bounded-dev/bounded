import type { Result } from "bounded/domain";
import type { SetupReport } from "../init-project/init-project.contract.ts";

// Out ports this feature shares with init-project: declared there, listed here so this contract names every port the feature needs.
export type { HostInstaller, HostInstallerSource, HostInstallReport, ProjectSetupFiles, SetupReport } from "../init-project/init-project.contract.ts";

// In port: what this feature offers.
/** `bounded update`'s refresh: point every host's hooks at the installed version. Never writes the configuration; idempotent. */
export interface UpdateProject {
  execute(projectRoot: string): Promise<Result<SetupReport>>;
}
