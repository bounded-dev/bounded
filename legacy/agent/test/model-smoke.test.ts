import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("reset deployment probes reject failures before touching arms (fake providers only)", () => {
  const suite = fileURLToPath(new URL("../../scripts/dogfood/model-smoke-fixtures.mjs", import.meta.url));
  const output = execFileSync(process.execPath, ["--test", suite], { encoding: "utf8", timeout: 15_000 });
  expect(output).toMatch(/(?:pass 4|tests 4)/);
}, 20_000);
