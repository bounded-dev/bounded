// The harness's own runtime package and its lockfile (ADR LEG-2026-051).
//
// The harness is itself a Node program, so the core may name the tools that
// run the harness — never the tools that build the project. This module is
// that accepted exception: it derives a pinned lockfile for a package from
// the harness's own source lock. A pack whose stack uses the same package
// manager may reuse it to derive the project's lockfile; the core never
// writes the project's manifests itself.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RuntimePackage = {
  name: string;
  version?: string;
  private?: boolean;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type LockEntry = {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
};

/** The harness source's lockfile: the checkout's own, or the generated data
 *  copy an installed CLI carries (the registry tarball omits the original). */
export function sourceLockPath(agentRoot: string): string {
  const checkout = join(agentRoot, "package-lock.json");
  return existsSync(checkout) ? checkout : join(agentRoot, "installer-lock.json");
}

/** A lockfile for `pkg` holding exactly the source lock's entries it reaches. */
export function lockFor(pkg: RuntimePackage, agentRoot: string): object {
  const source = JSON.parse(readFileSync(sourceLockPath(agentRoot), "utf8")) as {
    lockfileVersion: number; packages: Record<string, LockEntry>;
  };
  const selected = new Set<string>();
  const resolveDependency = (from: string, name: string): string | undefined => {
    let parent = from;
    for (;;) {
      const candidate = parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`;
      if (source.packages[candidate]) return candidate;
      const at = parent.lastIndexOf("/node_modules/");
      if (at < 0) {
        if (parent) { parent = ""; continue; }
        return undefined;
      }
      parent = parent.slice(0, at);
    }
  };
  const add = (path: string, optionalContext = false): void => {
    if (selected.has(path)) return;
    const entry = source.packages[path];
    if (!entry) throw new Error(`Dependency lock is missing '${path}'`);
    selected.add(path);
    for (const name of Object.keys(entry.dependencies ?? {})) {
      const resolved = resolveDependency(path, name);
      if (!resolved) {
        if (optionalContext) continue;
        throw new Error(`Dependency lock cannot resolve '${name}' from '${path}'`);
      }
      add(resolved, optionalContext);
    }
    for (const name of Object.keys(entry.optionalDependencies ?? {})) {
      const resolved = resolveDependency(path, name);
      if (resolved) add(resolved, true);
    }
    // Peer dependencies present in the source lock are retained; the package
    // manager may auto-install them in a clean tree even when not direct.
    for (const name of Object.keys(entry.peerDependencies ?? {})) {
      const resolved = resolveDependency(path, name);
      if (resolved) add(resolved, optionalContext);
    }
  };
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const path = resolveDependency("", name);
    if (!path) throw new Error(`Source lock has no pin for '${name}'`);
    if (source.packages[path].version !== version) throw new Error(`Source lock pins '${name}' to ${source.packages[path].version}, project requires ${version}`);
    add(path);
  }
  const packages: Record<string, LockEntry> = {
    "": { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies },
  };
  for (const path of [...selected].sort()) packages[path] = source.packages[path];
  return { name: pkg.name, version: pkg.version, lockfileVersion: source.lockfileVersion, requires: true, packages };
}
