// CLI for checking a portable design handoff before consumer start and integration.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReceipt, readReceipt } from "./handoff.ts";
import { isMainModule } from "./is-main-module.ts";

export function main(argv: readonly string[], cwd = process.cwd()): number {
  if (argv.length !== 3 || argv[0] !== "check") {
    console.error("usage: bounded handoff check <receipt.json> <producer-ref>");
    return 64;
  }
  try {
    const receipt = readReceipt(resolve(cwd, argv[1]!));
    const result = checkReceipt(cwd, receipt, argv[2]!);
    console.log(JSON.stringify({ producer: receipt.producer, revision: receipt.revision, ...result }));
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`handoff: ERROR — ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
