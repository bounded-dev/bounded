// What `bounded update` runs to upgrade the project's bounded packages: pure,
// the CLI (bounded-cli.ts) runs the commands.
import type { Result } from "bounded/domain";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

/** The lockfile that names each package manager; npm when none is present. */
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** The project's package manager, from the files at its root. */
export function packageManagerFor(fileNames: readonly string[]): PackageManager {
  return LOCKFILES.find(([lockfile]) => fileNames.includes(lockfile))?.[1] ?? "npm";
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The one tarball `<name>-<version>.tgz` among `fileNames`; a package with none, or several, is refused. */
export function tarballFor(name: string, fileNames: readonly string[]): Result<string> {
  const pattern = new RegExp(`^${escapeRegExp(name)}-\\d+\\.\\d+\\.\\d+[^/]*\\.tgz$`);
  const found = fileNames.filter((file) => pattern.test(file));
  const [only] = found;
  if (only === undefined) return { ok: false, error: `no ${name}-<version>.tgz to upgrade ${name} from: pack it (bun pm pack) into that directory` };
  if (found.length > 1) return { ok: false, error: `more than one tarball of ${name} (${found.join(", ")}): keep one` };
  return { ok: true, value: only };
}

/** A package to upgrade: its name, whether the project lists it in devDependencies, and what to install. */
export interface PackageToUpgrade {
  readonly name: string;
  readonly dev: boolean;
  readonly spec: string;
}

const ADD: Record<PackageManager, { readonly add: readonly string[]; readonly dev: string }> = {
  bun: { add: ["bun", "add"], dev: "--dev" },
  npm: { add: ["npm", "install"], dev: "--save-dev" },
  pnpm: { add: ["pnpm", "add"], dev: "--save-dev" },
  yarn: { add: ["yarn", "add"], dev: "--dev" },
};

/** The commands that install `packages`, dependencies first, each group where the project lists it. */
export function upgradeCommands(manager: PackageManager, packages: readonly PackageToUpgrade[]): string[][] {
  const { add, dev } = ADD[manager];
  const commands: string[][] = [];
  const dependencies = packages.filter((item) => !item.dev).map((item) => item.spec);
  const devDependencies = packages.filter((item) => item.dev).map((item) => item.spec);
  if (dependencies.length > 0) commands.push([...add, ...dependencies]);
  if (devDependencies.length > 0) commands.push([...add, dev, ...devDependencies]);
  return commands;
}

/**
 * The project's package.json with each package's spec replaced by `spec`, in
 * the group that lists it (dependencies by default). Used for bun, whose
 * `add` cannot replace one tarball dependency with another (bun 1.3.14
 * reports a dependency loop): bun installs from the rewritten manifest instead.
 */
export function withUpgradedSpecs(manifest: Readonly<Record<string, unknown>>, packages: readonly PackageToUpgrade[]): Record<string, unknown> {
  const group = (field: string): Record<string, unknown> => {
    const value = manifest[field];
    return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
  };
  const dependencies = group("dependencies");
  const devDependencies = group("devDependencies");
  for (const { name, dev, spec } of packages) (dev ? devDependencies : dependencies)[name] = spec;
  return { ...manifest, dependencies, ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {}) };
}
