#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readDeclaredReleaseTargets } from "./release-targets.ts";

const version = (JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as { version: string }).version;
const runners: Readonly<Record<string, string>> = {
  "darwin-arm64": "macos-15", "darwin-x64": "macos-15-intel",
  "linux-arm64-gnu": "ubuntu-24.04-arm", "linux-arm64-musl": "ubuntu-24.04-arm",
  "linux-x64-gnu": "ubuntu-24.04", "linux-x64-musl": "ubuntu-24.04",
  "windows-arm64": "windows-11-arm", "windows-x64": "windows-2025",
};
const include = readDeclaredReleaseTargets(version).map((target) => ({ target, runner: runners[target] }));
if (include.some((entry) => entry.runner === undefined)) throw new Error("release declaration contains a target without a fixed runner");
process.stdout.write(`${JSON.stringify({ include })}\n`);
