import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const repo = resolve(import.meta.dir, "../../..");
const workflowPath = resolve(repo, ".github/workflows/release.yml");
const smokePath = resolve(repo, "scripts/release/unix-native-smoke.sh");

test("native macOS release runs its installed launcher with network denied after online Gatekeeper launch", () => {
  expect(existsSync(workflowPath)).toBe(true);
  expect(existsSync(smokePath)).toBe(true);
  if (!existsSync(workflowPath) || !existsSync(smokePath)) return;
  const workflow = readFileSync(workflowPath, "utf8");
  const smoke = readFileSync(smokePath, "utf8");
  expect(workflow.indexOf("spctl --assess")).toBeGreaterThan(-1);
  expect(workflow.indexOf("scripts/release/unix-native-smoke.sh")).toBeGreaterThan(workflow.indexOf("spctl --assess"));
  expect(smoke).toContain("sandbox-exec -p");
  expect(smoke).toContain("(deny network*)");
  expect(smoke).toMatch(/sandbox-exec[^\n]*\$root\/bin\/bounded[^\n]*--version/);
  expect(smoke).toMatch(/sandbox-exec[^\n]*\$root\/bin\/bounded[^\n]*hook claude-code/);
});
