// The host installer `bounded init` and `bounded update` load from this
// package (its ./host-installer export): the loader pi discovers under
// .pi/extensions/, written only when the project uses pi (it has .pi/).
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostInstaller } from "bounded/application";
import { piLoader } from "./install.ts";

export const hostInstaller: HostInstaller = {
  host: "pi",
  async install(projectRoot) {
    if (!existsSync(join(projectRoot, ".pi"))) return { ok: true, value: { host: "pi", changedPaths: [], skippedBecause: "the project has no .pi/ directory; create it and run `bounded update` to use pi" } };
    const loader = piLoader();
    const path = join(projectRoot, loader.path);
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === loader.content) return { ok: true, value: { host: "pi", changedPaths: [], skippedBecause: null } };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, loader.content);
    return { ok: true, value: { host: "pi", changedPaths: [loader.path], skippedBecause: null } };
  },
};
