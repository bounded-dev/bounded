#!/usr/bin/env bun
import packageManifest from "./package.json";
import { dispatchStandalone } from "./standalone-dispatch.ts";

const args = process.argv.slice(2);
const dispatched = await dispatchStandalone(args, packageManifest.version);
if (!dispatched.answered) {
  if (args[0] === "--version" && args.length === 1) {
    process.stdout.write(`${packageManifest.version}\n`);
  } else {
    const { runStandaloneRuntime } = await import("./standalone-runtime.ts");
    await runStandaloneRuntime(args, packageManifest.version, dispatched.hostProjectRoot);
  }
}
