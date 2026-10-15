// Run before the tests (bunfig.toml): builds bounded's dist/, the JavaScript
// for node its export paths and bin point at (ADR 2026-016), so the
// architecture and packaging tests see what a release ships; then each
// published pack's package's dist/ (ADR 2026-030), which needs bounded's
// declarations.
import { Glob } from "bun";
import { join } from "node:path";
import { buildDist } from "./src/build-dist.ts";
import { buildPublishedPack } from "./src/build-published-pack.ts";

await buildDist();
for (const manifest of [...new Glob("src/published-packs/*/package.json").scanSync({ cwd: import.meta.dir })].sort()) {
  await buildPublishedPack(join(import.meta.dir, manifest.slice(0, -"/package.json".length)));
}
