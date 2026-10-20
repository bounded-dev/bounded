// The standalone project loader belongs to the core's project-config adapter,
// so Claude Code, pi and the CLI use the same verified snapshot implementation.
export { buildStandaloneConfigModule, standaloneManagedConfigSource, validateStandaloneManagedConfig } from "bounded/adapters";
