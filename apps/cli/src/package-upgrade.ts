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

const MANAGERS: readonly PackageManager[] = ["bun", "npm", "pnpm", "yarn"];
const managerNamed = (name: string | undefined): PackageManager | undefined => MANAGERS.find((manager) => manager === name);

/**
 * The project's package manager: its lockfile's; else package.json's
 * `packageManager` field (`bun@1.3.14`); else the one running this command
 * (npx, bunx, pnpm dlx and yarn dlx set `npm_config_user_agent`, such as
 * `bun/1.3.14 npm/? node/v24`); else npm. A fresh project has no lockfile yet.
 */
export function packageManagerOf(fileNames: readonly string[], manifest: Readonly<Record<string, unknown>>, userAgent: string | undefined): PackageManager {
  if (LOCKFILES.some(([lockfile]) => fileNames.includes(lockfile))) return packageManagerFor(fileNames);
  const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined;
  if (declared !== undefined) return managerNamed(declared) ?? "npm";
  return managerNamed(userAgent?.split("/")[0]) ?? "npm";
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

/** The version a tarball tarballFor picked holds, read from its name: `bounded-0.2.0.tgz` is 0.2.0. */
export function tarballVersion(name: string, tarball: string): string {
  return tarball.slice(name.length + 1, -".tgz".length);
}

const recordOf = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {});

/**
 * The manifest overriding `bounded` the way `manager` takes overrides, so
 * every package depending on `bounded` gets the project's own copy, not the
 * legacy 2.x on npm:
 * - npm (`overrides`) and pnpm (`pnpm.overrides`) refer to the direct
 *   dependency's own spec, `$bounded`; npm refuses an override that differs
 *   from it (EOVERRIDE), and the reference follows every upgrade by itself;
 * - bun (`overrides`) and yarn (`resolutions`) name the tarball, `file:<path>`.
 * Every other field and override is kept.
 */
export function withBoundedOverride(manifest: Readonly<Record<string, unknown>>, manager: PackageManager, tarballPath: string): Record<string, unknown> {
  const tarball = `file:${tarballPath}`;
  if (manager === "npm") return { ...manifest, overrides: { ...recordOf(manifest.overrides), bounded: "$bounded" } };
  if (manager === "pnpm") {
    const pnpm = recordOf(manifest.pnpm);
    return { ...manifest, pnpm: { ...pnpm, overrides: { ...recordOf(pnpm.overrides), bounded: "$bounded" } } };
  }
  if (manager === "yarn") return { ...manifest, resolutions: { ...recordOf(manifest.resolutions), bounded: tarball } };
  return { ...manifest, overrides: { ...recordOf(manifest.overrides), bounded: tarball } };
}

/** The command that installs what package.json names, once its specs and override are written: each manager's plain install. */
export function installCommand(manager: PackageManager): string[] {
  return [manager, "install"];
}

const ADD_TO: Record<PackageManager, { readonly add: readonly string[]; readonly dev: string }> = {
  bun: { add: ["bun", "add"], dev: "--dev" },
  npm: { add: ["npm", "install"], dev: "--save-dev" },
  pnpm: { add: ["pnpm", "add"], dev: "--save-dev" },
  yarn: { add: ["yarn", "add"], dev: "--dev" },
};

/**
 * The commands that upgrade `packages` to their latest version on the
 * registry, each kept in the group that lists it: dependencies first, then
 * devDependencies. The manager writes the new version into package.json and
 * its lockfile itself.
 */
export function upgradeToLatestCommands(manager: PackageManager, packages: readonly { readonly name: string; readonly dev: boolean }[]): string[][] {
  const { add, dev } = ADD_TO[manager];
  const latest = (wanted: boolean) => packages.filter((item) => item.dev === wanted).map((item) => `${item.name}@latest`);
  return [
    ...(latest(false).length > 0 ? [[...add, ...latest(false)]] : []),
    ...(latest(true).length > 0 ? [[...add, dev, ...latest(true)]] : []),
  ];
}

/** Compares two versions `major.minor.patch` (a pre-release suffix is ignored): negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split("-")[0]?.split(".").map((part) => Number.parseInt(part, 10) || 0) ?? [];
  const [left, right] = [parts(a), parts(b)];
  for (let at = 0; at < 3; at += 1) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The lockfiles a package manager may write: restored with package.json when an install is undone. */
export const LOCKFILE_NAMES: readonly string[] = LOCKFILES.map(([lockfile]) => lockfile);

/** A package to upgrade: its name, whether the project lists it in devDependencies, and what to install. */
export interface PackageToUpgrade {
  readonly name: string;
  readonly dev: boolean;
  readonly spec: string;
}

/**
 * The project's package.json with each package's spec replaced by `spec`, in
 * the group that lists it (dependencies by default). Every package manager
 * installs from this rewritten manifest: bun's `add` cannot replace one
 * tarball dependency with another (bun 1.3.14 reports a dependency loop), and
 * npm's `add` checks the `$bounded` override before the dependency exists.
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
