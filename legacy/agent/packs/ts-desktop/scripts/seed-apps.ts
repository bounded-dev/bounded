// The desktop pack's project initializer: the shared apps note, from ts-trpc
// across the declared edge (see packs/ts-trpc/scripts/seed-apps.ts).
import { resolve } from "node:path";
import { isMainModule } from "../../../src/is-main-module.ts";
import { seedApps } from "../../ts-trpc/scripts/seed-apps.ts";

if (isMainModule(import.meta.url)) {
  seedApps(resolve(process.argv[2] ?? process.cwd()));
}
