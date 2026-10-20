import { Ports, type Composition, type Config, type PortProvision, type Result } from "bounded/domain";

/** Validate the selected pack graph and host port wiring without running lifecycle callbacks. */
export function validateProjectWiring(config: Config, projectRoot: string, provisions: readonly PortProvision[]): Result<{
  readonly composition: Composition;
  readonly ports: Ports;
}> {
  const composed = config.compose();
  if (!composed.ok) return { ok: false, error: `its packs cannot be composed: ${composed.error}` };
  const ports = Ports.forProject(projectRoot, provisions);
  if (!ports.ok) return ports;
  const missing = composed.value.requiredPorts().find((key) => !ports.value.provides(key));
  if (missing !== undefined) return { ok: false, error: `${missing.owner.value} needs the port '${missing.name}', which this host does not provide: pass it to openProject({ ports })` };
  return { ok: true, value: { composition: composed.value, ports: ports.value } };
}
