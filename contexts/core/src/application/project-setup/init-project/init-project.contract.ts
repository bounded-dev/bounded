import type { Result } from "bounded/domain";

/** What one host installer did to a project: the project-relative paths it changed (none when already up to date), or why it skipped its host. */
export interface HostInstallReport {
  readonly host: string;
  readonly changedPaths: readonly string[];
  readonly skippedBecause: string | null;
}

/**
 * Installs one agent host's hooks into a project, pointing at the project's
 * own installed copy of the host adapter. A host adapter package offers one
 * as the `hostInstaller` export of its `./host-installer` export path; the
 * core never names a host. Idempotent: run again, it changes nothing.
 */
export interface HostInstaller {
  readonly host: string;
  install(projectRoot: string): Promise<Result<HostInstallReport>>;
}

/**
 * Out port: the host installers the project's installed packages offer.
 * @implementedBy system
 */
export interface HostInstallerSource {
  /** Every installer offered by a package in the project's dependencies, in package name order; none is not a failure. */
  load(projectRoot: string): Promise<Result<readonly HostInstaller[]>>;
}

/**
 * Out port: the project files setting up bounded reads and writes.
 * @implementedBy file-system
 */
export interface ProjectSetupFiles {
  /** The configuration files the project has, of bounded.config.ts, .js and .mjs, in that order. */
  configFileNames(projectRoot: string): Promise<Result<readonly string[]>>;
  /** Creates bounded.config.ts holding `content`, naming it; never overwrites an existing file. */
  createConfig(projectRoot: string, content: string): Promise<Result<string>>;
}

/** What setting up a project did: the configuration it wrote (null when none), and each host installer's report. */
export interface SetupReport {
  readonly configWritten: string | null;
  readonly hosts: readonly HostInstallReport[];
}

// In port: what this feature offers.
/** `bounded init`: set bounded up in a project with no configuration. */
export interface InitProject {
  execute(projectRoot: string): Promise<Result<SetupReport>>;
}
