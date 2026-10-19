import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const repo = resolve(import.meta.dir, "../../..");
const workflowPath = resolve(repo, ".github/workflows/release.yml");
const verifierPath = resolve(repo, "scripts/release/verify-draft-assets.ts");

test("the draft is fetched by its authenticated release ID before exact asset digest comparison", () => {
  expect(existsSync(workflowPath)).toBe(true);
  expect(existsSync(verifierPath)).toBe(true);
  if (!existsSync(workflowPath) || !existsSync(verifierPath)) return;
  const workflow = readFileSync(workflowPath, "utf8");
  const verifier = readFileSync(verifierPath, "utf8");
  expect(workflow).toContain("gh release create");
  expect(workflow).toContain("--draft --verify-tag");
  expect(workflow).toContain("gh api --paginate --slurp");
  expect(workflow).toMatch(/\.tag_name\s*==\s*\$tag/);
  expect(workflow).toMatch(/\.draft\s*==\s*true/);
  expect(workflow).toMatch(/releases\/\$release_id/);
  expect(workflow).not.toMatch(/releases\/tags\/\$tag/);
  expect(verifier).toContain("response.assets");
  expect(verifier).toContain("digest");
  expect(verifier).toContain("size");
});
