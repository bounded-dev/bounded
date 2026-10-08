// Select capabilities without regenerating or replacing any project source.
import { resolve } from "node:path";
import { composePacks } from "../src/socket-registry.ts";
import { writeProjectPacks } from "../src/project-composition.ts";
import { isMainModule } from "../src/is-main-module.ts";
import { INSTALLED_PACKS } from "./installed.ts";

export function selectPacks(cwd: string, names: readonly string[]): readonly string[] {
  const registry = composePacks(INSTALLED_PACKS, names);
  writeProjectPacks(cwd, registry.packs);
  return registry.packs;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  const flag = args.indexOf("--cwd");
  if (flag >= 0) {
    const directory = args[flag + 1];
    if (!directory || directory.startsWith("--")) {
      console.error("usage: bounded compose [--cwd <project>] <pack>...");
      process.exit(64);
    }
    cwd = resolve(directory);
    args.splice(flag, 2);
  }
  try {
    const names = selectPacks(cwd, args);
    console.log(`composition: ${names.join(", ")}`);
  } catch (error) {
    console.error(`composition: BLOCK — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
