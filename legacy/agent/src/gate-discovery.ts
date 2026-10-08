// Where the gates are (ADR LEG-2026-034): every `packs/<lang>/gates.ts` the packs
// directory holds, read by convention and never by name. Its own module so a
// background job's worker (gate-job-worker.ts) can find a gate without loading
// the command line's board and tracker machinery.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isGateRegistry, type GateCommand } from "./gate-command.ts";

/** Where the packs live, resolved from this file so the CLI works through the
 *  ~/.pi/agent symlink and from any cwd. */
export function packsDir(): string {
  return fileURLToPath(new URL("../packs/", import.meta.url));
}

/**
 * Every gate every pack contributes, in pack order. A `gates.ts` whose export
 * is not a registry is an error, not a skip: a pack that half-loads is a gate
 * that silently cannot be run.
 */
export async function discoverGates(dir: string = packsDir()): Promise<readonly GateCommand[]> {
  const found: GateCommand[] = [];
  const packs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const pack of packs) {
    const registry = join(dir, pack, "gates.ts");
    if (!existsSync(registry)) continue;
    const mod: unknown = await import(pathToFileURL(registry).href);
    const gates = typeof mod === "object" && mod !== null && "gates" in mod ? mod.gates : undefined;
    if (!isGateRegistry(gates)) throw new Error(`${registry}: the 'gates' export is not a gate registry`);
    found.push(...gates);
  }
  return found;
}
