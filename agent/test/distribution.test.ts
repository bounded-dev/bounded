// The npm package runs `bounded init` from its compiled dist/, and so does a
// checkout once `npm run build:dist` has made one. A compiled pack script finds
// its data — contrib.json, reference/, templates/, package.json files — beside
// itself, so a distribution missing any of them fails only where dist/ exists,
// which a plain checkout never sees. This suite packs the harness the way npm
// does, builds the distribution into it, installs it under node_modules, and
// initializes the default stack from there.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const AGENT = resolve(import.meta.dirname, "..");
const BUILD = join(AGENT, "scripts", "build-distribution.mjs");

/** The paths `npm pack` would publish from `dir`, without running prepack. */
function packList(dir: string): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: dir, encoding: "utf8" });
  return (JSON.parse(out) as { files: { path: string }[] }[])[0]!.files.map((file) => file.path);
}

/** Files under `root`/`rel`, skipping installed dependencies and fixtures. */
function filesUnder(root: string, rel: string): string[] {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const path = `${rel}/${entry.name}`;
    if (entry.name === "node_modules" || entry.name === "testdata") return [];
    return entry.isDirectory() ? filesUnder(root, path) : [path];
  });
}

/** npm never publishes a .gitignore; nothing at runtime reads one from a pack. */
const publishable = (path: string): boolean => !path.endsWith("/.gitignore");

const packs = readdirSync(join(AGENT, "packs"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

let temp = "";
let installed = "";
let tarball: string[] = [];
/** Top-level node_modules entries in the package's production dependency
 *  closure, as npm resolves it (nested copies travel inside their parents). */
function productionPackages(root: string): string[] {
  let out: string;
  try {
    out = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8" });
  } catch (error) {
    out = (error as { stdout?: string }).stdout ?? "";
  }
  const prefix = join(root, "node_modules") + "/";
  const names = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const rel = line.slice(prefix.length);
    if (rel.includes("/node_modules/")) continue;
    const parts = rel.split("/");
    names.add(parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!);
  }
  return [...names].sort();
}

let assets: string[] = [];

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), "bounded-dist-test-"));
  installed = join(temp, "node_modules", "bounded");
  // The package as npm would publish it, minus any dist/ already in the checkout.
  for (const path of packList(AGENT).filter((p) => !p.startsWith("dist/") && p !== "installer-lock.json" && p !== "build-info.json")) {
    mkdirSync(dirname(join(installed, path)), { recursive: true });
    copyFileSync(join(AGENT, path), join(installed, path));
  }
  copyFileSync(join(AGENT, "package-lock.json"), join(installed, "installer-lock.json"));
  const script = `const m = await import(${JSON.stringify(BUILD)});
    m.buildDistribution(${JSON.stringify(AGENT)}, ${JSON.stringify(join(installed, "dist"))});
    console.log(JSON.stringify(m.distributionAssets(${JSON.stringify(AGENT)}, ${JSON.stringify(join(installed, "dist"))})));`;
  assets = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })) as string[];
  // Its dependencies resolve as a global install's would: only the production
  // closure, never the devDependencies a checkout happens to have installed.
  // (A full node_modules here once hid a shipped lint rule importing a
  // dev-only package, which crashed every global `bounded init`.)
  for (const name of productionPackages(AGENT)) {
    mkdirSync(dirname(join(installed, "node_modules", name)), { recursive: true });
    symlinkSync(join(AGENT, "node_modules", name), join(installed, "node_modules", name), "dir");
  }
  tarball = packList(installed);
}, 120_000);
afterAll(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

describe("the npm distribution", () => {
  test("carries every pack's data beside its compiled scripts, and ships it", () => {
    const published = new Set(tarball);
    for (const pack of packs) {
      for (const data of ["contrib.json", "package.json"]) {
        const path = `packs/${pack}/${data}`;
        if (!filesUnder(AGENT, `packs/${pack}`).includes(path)) continue;
        expect(assets).toContain(path);
        expect(published).toContain(`dist/${path}`);
      }
    }
    expect(published).toContain("dist/packs/default-stack.json");
    for (const asset of assets.filter(publishable)) expect(published).toContain(`dist/${asset}`);
  });

  test("ships each reference project whole, tests included, in source and in dist", () => {
    const published = new Set(tarball);
    const reference = packs.flatMap((pack) => {
      try { return filesUnder(AGENT, `packs/${pack}/reference`); } catch { return []; }
    });
    expect(reference.some((path) => path.endsWith(".test.ts"))).toBe(true);
    for (const path of reference.filter(publishable)) {
      expect(published).toContain(path);
      expect(published).toContain(`dist/${path}`);
    }
  });

  test("every package the shipped code imports at runtime is a runtime dependency", () => {
    // Packages the pi host itself provides to its extensions at runtime.
    const hostProvided = new Set(["typebox", "@earendil-works/pi-coding-agent"]);
    const manifest = JSON.parse(readFileSync(join(AGENT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const runtime = new Set(Object.keys(manifest.dependencies ?? {}));
    const missing: string[] = [];
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return ["reference", "templates", "testdata", "node_modules"].includes(entry.name) ? [] : walk(path);
      return entry.name.endsWith(".js") && !entry.name.endsWith(".test.js") ? [path] : [];
    });
    for (const file of walk(join(installed, "dist"))) {
      // Value imports only, at the start of a line: emitted code lives inside
      // template literals and type-only imports are erased.
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/^import (?!type )[^"'\n]*?from ["']([^."'/][^"']*)["'];?$/gm)) {
        if (spec!.includes(":")) continue; // node:, bun: and other runtime builtins
        const name = spec!.startsWith("@") ? spec!.split("/").slice(0, 2).join("/") : spec!.split("/")[0]!;
        if (!runtime.has(name) && !hostProvided.has(name)) missing.push(`${file.slice(installed.length + 1)} -> ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the installed CLI initializes the default stack from its compiled code", () => {
    const target = join(temp, "example-project");
    mkdirSync(target);
    // Through the bin under node_modules: node there cannot type-strip, so
    // every pack script init runs must come from dist/.
    const out = execFileSync(join(installed, "scripts", "bounded"), ["init", "--host", "claude-code", "--cwd", target], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const plan = JSON.parse(out) as { action: string; packs: string[]; paths: string[] };
    expect(plan.action).toBe("plan");
    expect(plan.packs).toEqual(["ts", "ts-hexagonal", "ts-trpc", "ts-mcp", "ts-lambda", "ts-web", "ts-desktop", "ts-drizzle-postgres"]);
    // project-package's output: the manifest and the lockfile it pins.
    expect(plan.paths).toEqual(expect.arrayContaining(["package.json", "bun.lock", "tsconfig.json",
      ".bounded/harness/packs/ts-hexagonal/reference/contexts/project-management/src/domain/projects/project-name.test.ts"]));
  }, 120_000);
});
