import type { Result } from "bounded/domain";
import type { HostInstaller, HostInstallerSource, HostInstallReport, InitProject, ProjectSetupFiles, SetupReport } from "./init-project.contract.ts";

/** The project's host installers, or a refusal when there are none: a project bounded cannot hook into is not set up. */
export async function loadInstallers(hostInstallerSource: HostInstallerSource, projectRoot: string): Promise<Result<readonly HostInstaller[]>> {
  const loaded = await hostInstallerSource.load(projectRoot);
  if (!loaded.ok) return loaded;
  if (loaded.value.length === 0) {
    return { ok: false, error: `No package in ${projectRoot}'s dependencies offers a host installer: install the host adapter package for your agent host beside bounded, then run this again` };
  }
  return loaded;
}

/** Runs every installer in turn; the first that fails stops the rest, naming its host. */
export async function runInstallers(installers: readonly HostInstaller[], projectRoot: string): Promise<Result<readonly HostInstallReport[]>> {
  const reports: HostInstallReport[] = [];
  for (const installer of installers) {
    const installed = await installer.install(projectRoot);
    if (!installed.ok) return { ok: false, error: `${installer.host}: ${installed.error}` };
    reports.push(installed.value);
  }
  return { ok: true, value: reports };
}

export class InitProjectHandler implements InitProject {
  constructor(
    private readonly files: ProjectSetupFiles,
    private readonly hostInstallerSource: HostInstallerSource,
    /** The configuration to write: content, so the caller's (the CLI's); the core only writes it. */
    private readonly initialConfig: string,
  ) {}

  async execute(projectRoot: string): Promise<Result<SetupReport>> {
    const present = await this.files.configFileNames(projectRoot);
    if (!present.ok) return present;
    if (present.value.length > 0) {
      return { ok: false, error: `${projectRoot} already has ${present.value.join(", ")}: init never overwrites a configuration. Run \`bounded update\` to bring its hooks up to date` };
    }
    const installers = await loadInstallers(this.hostInstallerSource, projectRoot);
    if (!installers.ok) return installers;
    const written = await this.files.createConfig(projectRoot, this.initialConfig);
    if (!written.ok) return written;
    const hosts = await runInstallers(installers.value, projectRoot);
    if (!hosts.ok) return { ok: false, error: `${written.value} was written, but a host could not be installed: ${hosts.error}. Fix it, then run \`bounded update\`` };
    return { ok: true, value: { configWritten: written.value, hosts: hosts.value } };
  }
}
