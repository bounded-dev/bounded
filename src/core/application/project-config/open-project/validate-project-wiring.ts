import { Ports, type Composition, type Config, type PortProvision, type Result } from "bounded/domain";

/** Validate the selected pack graph and host port wiring without running lifecycle callbacks. */
export function validateProjectWiring(config: Config, projectRoot: string, provisions: readonly PortProvision[]): Result<{
  readonly composition: Composition;
  readonly ports: Ports;
}> {
  const composed = config.compose();
  if (!composed.ok) return { ok: false, error: `its packs cannot be composed: ${composed.error}` };
  if (config.portProvisionsProblem !== undefined) return { ok: false, error: config.portProvisionsProblem };
  const projectPorts = Ports.forProject(projectRoot, config.ports);
  if (!projectPorts.ok) return projectPorts;
  for (const provided of config.ports) {
    const key = provided.key;
    const owner = composed.value.packs.find((pack) => pack.id.value === key.owner.value);
    if (owner === undefined) return { ok: false, error: `${key.owner.value} port '${key.name}' is provided by this project but its pack is not selected: select the pack or remove the provision` };
    const declared = [...Object.values(owner.ports), ...Object.values(owner.optionalPorts)]
      .some((candidate) => candidate.toJSON() === key.toJSON());
    if (!declared) return { ok: false, error: `${key.owner.value} port '${key.name}' is not declared by the selected pack: declare the port there or remove the provision` };
  }
  const ports = Ports.forProject(projectRoot, [...provisions, ...config.ports]);
  if (!ports.ok) return ports;
  const missing = composed.value.requiredPorts().find((key) => !ports.value.provides(key));
  if (missing !== undefined) return { ok: false, error: `${missing.owner.value} needs the port '${missing.name}', which this host and project do not provide: add Ports.provide(...) to defineConfig({ ports: [...] }) or pass it to openProject({ ports })` };
  return { ok: true, value: { composition: composed.value, ports: ports.value } };
}
