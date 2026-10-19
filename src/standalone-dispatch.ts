import { spawn } from "node:child_process";
import { lstatSync, readFileSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import { locateInstalledRelease } from "./standalone-installed-release.ts";

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
type Root = { readonly ok: true; readonly root: string; readonly explicit: boolean } | { readonly ok: false; readonly error: string };
type Pin = { readonly ok: true; readonly version: string | null; readonly boundaryFound: boolean } | { readonly ok: false; readonly error: string };

function lstatIfPresent(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function explicitDirectory(path: string, source: string): Root {
  if (!isAbsolute(path)) return { ok: false, error: `${source} must name an absolute project directory` };
  try {
    if (!statSync(path).isDirectory()) return { ok: false, error: `${source} is not a project directory` };
    return { ok: true, root: path, explicit: true };
  } catch {
    return { ok: false, error: `${source} is missing or unreadable as a project directory` };
  }
}

function projectRoot(args: readonly string[], env: NodeJS.ProcessEnv): Root {
  if (args[0] === "hook" && args[1] === "claude-code") {
    const options = args.slice(2);
    const projectAt = options.indexOf("--project");
    if (projectAt !== -1) {
      const namedProject = options[projectAt + 1];
      if (options.indexOf("--project", projectAt + 1) !== -1 || namedProject === undefined || namedProject.startsWith("--")) {
        return { ok: false, error: "hook claude-code --project requires one absolute project directory" };
      }
      return explicitDirectory(namedProject, "--project");
    }
    if (env.CLAUDE_PROJECT_DIR !== undefined) return explicitDirectory(env.CLAUDE_PROJECT_DIR, "CLAUDE_PROJECT_DIR");
  }
  return { ok: true, root: process.cwd(), explicit: false };
}

function pinIn(root: string): Pin {
  const boundary = join(root, ".bounded");
  try {
    const boundaryInfo = lstatIfPresent(boundary);
    if (boundaryInfo === null) return { ok: true, version: null, boundaryFound: false };
    if (boundaryInfo.isSymbolicLink() || !boundaryInfo.isDirectory()) return { ok: false, error: `${boundary} is linked or not a readable project directory` };
    const pinPath = join(boundary, "version.json");
    const pinInfo = lstatIfPresent(pinPath);
    if (pinInfo === null) return { ok: true, version: null, boundaryFound: true };
    if (pinInfo.isSymbolicLink() || !pinInfo.isFile()) return { ok: false, error: `${pinPath} is linked or not a file; restore the project's Bounded version pin` };
    const raw: unknown = JSON.parse(readFileSync(pinPath, "utf8"));
    if (!isRecord(raw) || Object.keys(raw).sort().join() !== ["schema", "version"].sort().join() || raw.schema !== "bounded-project-version/1" || typeof raw.version !== "string" || !versionPattern.test(raw.version)) {
      return { ok: false, error: `${pinPath} has an invalid Bounded project version pin` };
    }
    return { ok: true, version: raw.version, boundaryFound: true };
  } catch {
    return { ok: false, error: `${boundary}/version.json is unreadable or malformed; restore the project's Bounded version pin` };
  }
}

function projectPin(root: Root): Pin {
  if (!root.ok) return root;
  if (root.explicit) return pinIn(root.root);
  let directory = root.root;
  for (;;) {
    const candidate = pinIn(directory);
    if (!candidate.ok || candidate.boundaryFound) return candidate;
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) return { ok: true, version: null, boundaryFound: false };
    directory = parent;
  }
}

function handOff(executable: string, args: readonly string[], version: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", env: { ...process.env, BOUNDED_DISPATCHED_VERSION: version } });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        process.stderr.write(`Installed Bounded ${version} was terminated by signal ${signal}; the call stays refused\n`);
        resolveExit(2);
      } else resolveExit(code ?? 2);
    });
  });
}

/** Handoff before any CLI/config/host payload parsing; return true when this process has answered the call. */
export async function dispatchStandalone(args: readonly string[], currentVersion: string): Promise<{ readonly answered: boolean; readonly hostProjectRoot?: string }> {
  const marker = process.env.BOUNDED_DISPATCHED_VERSION;
  if (marker !== undefined && marker !== currentVersion) {
    process.stderr.write(`Bounded dispatch hop targets ${marker}, but this executable is ${currentVersion}\n`);
    process.exitCode = 2;
    return { answered: true };
  }
  // The marker is a one-hop control value, never ambient configuration for
  // project code or a nested bounded process a handler may start.
  if (marker !== undefined) delete process.env.BOUNDED_DISPATCHED_VERSION;
  if ((args[0] === "--version" && args.length === 1) || args[0] === "update") return { answered: false };
  const root = projectRoot(args, process.env);
  const pin = projectPin(root);
  if (!pin.ok) {
    process.stderr.write(`${pin.error}\n`);
    process.exitCode = 2;
    return { answered: true };
  }
  if (pin.version !== null && pin.version !== currentVersion) {
    if (marker !== undefined) {
      process.stderr.write(`Bounded dispatch would require a second hop from ${currentVersion} to ${pin.version}; repair the project pin\n`);
      process.exitCode = 2;
      return { answered: true };
    }
    const located = locateInstalledRelease(pin.version);
    if (!located.ok) {
      process.stderr.write(`${located.error}\n`);
      process.exitCode = 2;
      return { answered: true };
    }
    try { process.exitCode = await handOff(located.executable, args, pin.version); }
    catch (error) {
      process.stderr.write(`Cannot start installed Bounded ${pin.version}: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
    return { answered: true };
  }
  return { answered: false, ...(root.ok && root.explicit && args[0] === "hook" && args[1] === "claude-code" ? { hostProjectRoot: root.root } : {}) };
}
