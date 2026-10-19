#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const [directory, responsePath] = process.argv.slice(2);
if (!directory || !responsePath) throw new Error("usage: verify-draft-assets.ts <assets-directory> <release-assets.json>");
const response: unknown = JSON.parse(readFileSync(responsePath, "utf8"));
if (typeof response !== "object" || response === null || !("assets" in response) || !Array.isArray(response.assets)) throw new Error("draft release asset response is malformed");
const expected = readdirSync(directory).sort().map((name) => {
  const bytes = readFileSync(join(directory, name));
  return { name: basename(name), size: bytes.byteLength, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
});
const received = response.assets.map((asset: unknown) => {
  if (typeof asset !== "object" || asset === null || !("name" in asset) || !("size" in asset) || !("digest" in asset)) throw new Error("draft release asset digest is missing");
  return { name: asset.name, size: asset.size, digest: asset.digest };
}).sort((left, right) => String(left.name).localeCompare(String(right.name)));
if (JSON.stringify(received) !== JSON.stringify(expected)) throw new Error("draft release assets or digests do not match the assembled release");
