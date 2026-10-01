// Dogfood prompt files hold only the prompt text, so a person can select all
// and paste it into a run. Notes about a prompt live in docs/dogfood/README.md.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "dogfood");
const prompts = readdirSync(promptsDir).filter((name) => !name.startsWith(".") && name.endsWith("-prompt.md")).sort();

describe("dogfood prompts are copy-ready", () => {
  test("the folder has prompts to check", () => {
    expect(prompts.length).toBeGreaterThan(0);
  });

  test.each(prompts)("%s carries no comment or usage header", (name) => {
    const text = readFileSync(join(promptsDir, name), "utf8");
    expect(text.trimStart().startsWith("<!--"), `${name}: move the header into docs/dogfood/README.md`).toBe(false);
    expect(text.includes("<!--"), `${name}: prompt files hold only the prompt`).toBe(false);
  });

  test("every prompt has an entry in the notes index", () => {
    const index = readFileSync(join(promptsDir, "README.md"), "utf8");
    for (const name of prompts) expect(index, name).toContain(`\`${name}\``);
  });
});
