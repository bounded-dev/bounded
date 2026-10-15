import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, sep } from "node:path";

type RuntimeExports = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const BOUNDED_EXPORTS = "__boundedStandaloneRuntimeExports";
const isInside = (root: string, path: string): boolean => path.startsWith(`${root}${sep}`);

/**
 * Compile a project's module graph against the core already in the executable.
 * A fresh output directory keeps nested-source edits visible even when file
 * metadata is unchanged. It stays until process exit for lazy imports.
 */
export async function buildStandaloneConfigModule(configFile: string, projectRoot: string): Promise<string> {
  const exports: unknown = Reflect.get(globalThis, BOUNDED_EXPORTS);
  if (typeof exports !== "object" || exports === null) throw new Error("the standalone runtime exports are unavailable");
  const runtimeExports = exports as RuntimeExports;
  const home = realpathSync(projectRoot);
  const outputDirectory = mkdtempSync(join(tmpdir(), "bounded-project-config-"));
  process.once("exit", () => rmSync(outputDirectory, { recursive: true, force: true }));
  let unavailableImport: string | undefined;
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
    entrypoints: [configFile],
    outdir: outputDirectory,
    target: "bun",
    format: "esm",
    allowUnresolved: [],
    plugins: [{
      name: "bounded-standalone-project-modules",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => {
          if (path.startsWith("node:") || path.startsWith("bun:")) return { path, external: true };
          if (Object.hasOwn(runtimeExports, path)) return { path, namespace: "bounded-standalone-runtime" };
          unavailableImport = `import '${path}' is not available to this project: use a public bounded export or install and pin the pack with bounded`;
          throw new Error(unavailableImport);
        });
        build.onLoad({ filter: /.*/, namespace: "bounded-standalone-runtime" }, ({ path }) => {
          const names = Object.keys(runtimeExports[path] ?? {});
          return { contents: names.map((name) => `export const ${name} = globalThis.${BOUNDED_EXPORTS}[${JSON.stringify(path)}][${JSON.stringify(name)}];`).join("\n"), loader: "js" };
        });
        build.onLoad({ filter: /.*/, namespace: "file" }, ({ path }) => {
          const real = realpathSync(path);
          if (!isInside(home, real)) {
            unavailableImport = `import '${path}' resolves outside ${projectRoot}: project modules must live in the project`;
            throw new Error(unavailableImport);
          }
          const extension = extname(path);
          const loader = extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts" : extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx" : extension === ".json" ? "json" : extension === ".js" || extension === ".mjs" || extension === ".cjs" ? "js" : undefined;
          if (loader === undefined) {
            unavailableImport = `import '${path}' uses an unsupported module type: project modules must be TypeScript, JavaScript or JSON`;
            throw new Error(unavailableImport);
          }
          return { contents: readFileSync(real, "utf8"), loader };
        });
      },
    }],
    });
  } catch (thrown) {
    throw new Error(unavailableImport ?? (thrown instanceof Error ? thrown.message : String(thrown)));
  }
  if (!built.success) throw new Error(unavailableImport ?? built.logs.map((log) => log.message).join("; "));
  const entry = built.outputs.find((output) => output.kind === "entry-point");
  if (entry === undefined) throw new Error("the standalone configuration build produced no entry module");
  return entry.path;
}
