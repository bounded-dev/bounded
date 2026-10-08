// Run before the tests (bunfig.toml): builds bounded's dist/, the JavaScript
// for node its export paths and bin point at (ADR 2026-016), so the
// architecture and packaging tests see what a release ships.
import { buildDist } from "./contexts/core/build-dist.ts";

await buildDist();
