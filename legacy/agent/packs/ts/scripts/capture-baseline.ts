import { captureChangeBaseline } from "./change-baseline.ts";

const cwd = process.argv[2] ?? process.cwd();
try {
  const baseline = captureChangeBaseline(cwd);
  console.log(`change-baseline: captured ${Object.keys(baseline.files).length} design and knowledge files (${baseline.fingerprint.slice(0, 12)})`);
} catch (error) {
  console.error(`change-baseline: BLOCK — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
