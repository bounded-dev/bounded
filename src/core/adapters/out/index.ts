// bounded/adapters: the core's out adapters, one folder per port (ADR 2026-017), for hosts' composition roots.
export { SystemClock } from "./clock/clock.ts";
export { InMemoryComposePacksCatalog } from "./compose-packs-catalog/compose-packs-catalog.ts";
export { RandomDecisionIds } from "./decision-ids/decision-ids.ts";
export { FileSystemBoundedLog } from "./bounded-log/bounded-log.ts";
export { NodeModulesHostInstallerSource } from "./host-installer-source/host-installer-source.ts";
export { CheckedProjectConfigSource } from "./project-config-source/checked-project-config-source.ts";
export { FileSystemProjectConfigSource } from "./project-config-source/file-system-project-config-source.ts";
export { buildStandaloneConfigModule, prepareStandaloneProjectSnapshot, disposeStandaloneProjectSnapshot, standaloneManagedConfigSource,
  validateStandaloneManagedConfig, type StandaloneProjectSnapshot, type StandaloneSnapshotOptions } from "./project-config-source/standalone-config-as-module.ts";
export { boundedDeclarationTargets, checkStandaloneProjectSnapshot } from "./project-config-source/standalone-type-check.ts";
export { PROJECT_CONFIG_NAMES } from "./project-config-source/project-config-names.ts";
export { FileSystemProjectBoundedLogs } from "./project-bounded-logs/project-bounded-logs.ts";
export { FileSystemProjectSetupFiles } from "./project-setup-files/project-setup-files.ts";
// The package catalogue build's (ADR 2026-029); each loads its libraries from the package it catalogues.
export { FileSystemPackageCatalogFiles } from "./package-catalog-files/package-catalog-files.ts";
export { MarkedMarkdownSections } from "./markdown-sections/markdown-sections.ts";
export { BunPackModules } from "./pack-modules/pack-modules.ts";
export { packageExportsResolve } from "./pack-modules/node-import-export-target.ts";
export { TypeScriptPackSourceApi } from "./pack-source-api/pack-source-api.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
