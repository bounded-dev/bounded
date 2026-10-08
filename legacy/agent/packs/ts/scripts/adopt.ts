import { adoptProject } from "./change-baseline.ts";

const cwd = process.argv[2] ?? process.cwd();
try {
  const baseline = await adoptProject(cwd);
  console.log(`adopt: OK — validated and recorded ${Object.keys(baseline.files).length} files (${baseline.fingerprint.slice(0, 12)}); no run verdicts were created`);
} catch (error) {
  console.error(`adopt: BLOCK — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
