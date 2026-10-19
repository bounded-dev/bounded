#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readReleaseManifest } from "../../src/cli/release-manifest.ts";
import { installerScripts } from "../../src/release-install-scripts.ts";

const [jobDirectory, outputDirectory] = process.argv.slice(2);
if (!jobDirectory || !outputDirectory) throw new Error("usage: render-native-installer.ts <job-directory> <output-directory>");
const packageVersion = (JSON.parse(readFileSync("src/package.json", "utf8")) as { version: string }).version;
const bytes = readFileSync(join(jobDirectory, `bounded-v${packageVersion}-manifest-v1.json`));
const digest = createHash("sha256").update(bytes).digest("hex");
const parsed = readReleaseManifest(bytes, digest, packageVersion);
if (!parsed.ok) throw new Error(parsed.error);
const scripts = installerScripts(parsed.value, digest);
writeFileSync(join(outputDirectory, "install.sh"), scripts.unix);
writeFileSync(join(outputDirectory, "install.ps1"), scripts.windows);
