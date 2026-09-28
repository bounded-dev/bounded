// Seed the service workspace during bounded init. The application contract,
// router, and HTTP entry are product decisions and arrive in later work. The
// foundational scaffold step copies the pinned service runtime as soon as a
// service contract imports it; emitting that runtime here would be premature
// and the scaffold step would correctly prune it while no contract exists.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMainModule } from "../../../src/is-main-module.ts";

const PLACEHOLDER = "src/api/.gitkeep";
const CONTENT = [
  "# GENERATED from packs/ts-service/scripts/new-service.ts by bounded init — do not edit.",
  "API contracts and their implementation live here after the product has been designed.",
  "The design gate supplies service-runtime.ts when a service contract imports it.",
  "The builder adds server.ts with the project's real context and router; npm run build:api",
  "then npm run start:api compile and run that entry point.",
  "",
].join("\n");

export function seedService(target: string): void {
  const runtime = join(target, ".bounded/harness/packs/ts-service/api/service-runtime.ts");
  if (!existsSync(runtime)) throw new Error("The selected TypeScript capability is missing its service runtime");
  const path = join(target, PLACEHOLDER);
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== CONTENT) {
      throw new Error(`${PLACEHOLDER} already contains project work`);
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, CONTENT);
}

if (isMainModule(import.meta.url)) {
  seedService(resolve(process.argv[2] ?? process.cwd()));
}
