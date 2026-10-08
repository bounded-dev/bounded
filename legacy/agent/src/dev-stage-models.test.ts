import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DEV_STAGE_MODELS_RELATIVE,
  NO_DEV_STAGE_MODELS,
  TIER_BY_ROLE,
  TIER_KEY,
  devStageModelsPath,
  parseDevStageModels,
  patternForTier,
  readDevStageModels,
  tierForAgent,
} from "./dev-stage-models.ts";
import { ZONES } from "./path-policy.ts";

// WHY THIS EXISTS
//
// Two model tiers set per project (issue #13). The arithmetic is trivial — read
// two strings out of a JSON file — and every interesting property is about what
// happens when the file is WRONG. The rule is absolute: a missing, unreadable,
// malformed or half-typo'd config means "no override", never an error, because
// a speed knob that can kill a run is worse than no speed knob. Each of those
// paths has a test here, and each would be a silent behaviour change if it
// stopped holding.

const dirs: string[] = [];
function project(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dev-stage-models-"));
  dirs.push(dir);
  if (contents !== undefined) {
    const path = devStageModelsPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("the role→tier mapping is harness-owned", () => {
  test("judgment seats draw on designModel, production seats on workerModel", () => {
    expect(TIER_BY_ROLE).toEqual({
      architect: "design",
      reviewer: "design",
      "test-writer": "worker",
      builder: "worker",
    });
    expect(TIER_KEY).toEqual({ design: "designModel", worker: "workerModel" });
  });

  // The same drift check agent-config-drift makes for tools: a fifth pipeline
  // role added to the path policy without a tier would be a seat nobody had
  // decided the price of.
  test("every pipeline role has a tier, and no tier names a non-role", () => {
    expect(Object.keys(TIER_BY_ROLE).sort()).toEqual(Object.keys(ZONES).sort());
  });

  test("agents outside the pipeline have no tier", () => {
    expect(tierForAgent("scout")).toBeUndefined();
    expect(tierForAgent("product-expert")).toBeUndefined();
    expect(tierForAgent("delegate")).toBeUndefined();
    expect(tierForAgent("")).toBeUndefined();
    expect(tierForAgent(undefined)).toBeUndefined();
    expect(tierForAgent(42)).toBeUndefined();
  });

  // A JSON object's inherited keys are not its own: `{"toString": …}` must not
  // make `toString` a tiered role.
  test("prototype keys are not roles", () => {
    expect(tierForAgent("toString")).toBeUndefined();
    expect(tierForAgent("constructor")).toBeUndefined();
  });
});

describe("a valid config", () => {
  test("both tiers read back, thinking suffix intact", () => {
    const models = parseDevStageModels(
      '{"designModel": "anthropic/claude-opus-4:high", "workerModel": "fireworks/kimi-k3-fast:medium"}',
    );
    expect(models.design).toBe("anthropic/claude-opus-4:high");
    expect(models.worker).toBe("fireworks/kimi-k3-fast:medium");
    expect(models.warnings).toEqual([]);
    expect(patternForTier(models, "design")).toBe("anthropic/claude-opus-4:high");
    expect(patternForTier(models, "worker")).toBe("fireworks/kimi-k3-fast:medium");
  });

  test("one tier alone is legal — the other stays on the session default", () => {
    const models = parseDevStageModels('{"designModel": "anthropic/claude-opus-4:high"}');
    expect(models.design).toBe("anthropic/claude-opus-4:high");
    expect(models.worker).toBeUndefined();
    expect(models.warnings).toEqual([]);
  });

  test("an empty object is a legal no-op", () => {
    expect(parseDevStageModels("{}")).toEqual({ warnings: [] });
  });

  test("surrounding whitespace is trimmed off a pattern", () => {
    expect(parseDevStageModels('{"workerModel": "  x/y:medium  "}').worker).toBe("x/y:medium");
  });

  test("it is read from .bounded/, beside the role file and the guard log", () => {
    expect(DEV_STAGE_MODELS_RELATIVE).toBe(".bounded/dev-stage-models.json");
    const dir = project('{"designModel": "a/b:high"}');
    expect(devStageModelsPath(dir)).toBe(join(dir, ".bounded", "dev-stage-models.json"));
    expect(readDevStageModels(dir).design).toBe("a/b:high");
  });
});

describe("absence is the normal case, not a problem", () => {
  test("no file at all ⇒ no override, no warning", () => {
    expect(readDevStageModels(project())).toEqual(NO_DEV_STAGE_MODELS);
  });

  test("a directory that does not exist ⇒ no override, no warning", () => {
    expect(readDevStageModels(join(tmpdir(), "no-such-project-dir-9d2f"))).toEqual(
      NO_DEV_STAGE_MODELS,
    );
  });

  test("an unreadable file reads like an absent one rather than throwing", () => {
    const dir = project('{"designModel": "a/b:high"}');
    chmodSync(devStageModelsPath(dir), 0o000);
    // Running as root defeats the permission bits; the property under test is
    // only that no throw escapes, which holds either way.
    expect(() => readDevStageModels(dir)).not.toThrow();
  });
});

describe("malformed is ignored and warned, never fatal", () => {
  test("not JSON at all", () => {
    const models = parseDevStageModels("designModel: opus\n");
    expect(models.design).toBeUndefined();
    expect(models.worker).toBeUndefined();
    expect(models.warnings).toHaveLength(1);
    expect(models.warnings[0]).toContain("not valid JSON");
  });

  test("truncated JSON, read off disk, does not throw", () => {
    const dir = project('{"designModel": "a/b:high"');
    const models = readDevStageModels(dir);
    expect(models.design).toBeUndefined();
    expect(models.warnings).toHaveLength(1);
  });

  for (const [label, raw] of [
    ["an array", "[]"],
    ["null", "null"],
    ["a bare string", '"anthropic/claude-opus-4"'],
    ["a number", "7"],
  ] as const) {
    test(`${label} is not a config object`, () => {
      const models = parseDevStageModels(raw);
      expect(models.design).toBeUndefined();
      expect(models.worker).toBeUndefined();
      expect(models.warnings).toHaveLength(1);
      expect(models.warnings[0]).toContain("must be a JSON object");
    });
  }

  test("a non-string value is ignored and named", () => {
    const models = parseDevStageModels('{"designModel": 5, "workerModel": "x/y:medium"}');
    expect(models.design).toBeUndefined();
    expect(models.worker).toBe("x/y:medium"); // one bad key does not discard the other
    expect(models.warnings).toHaveLength(1);
    expect(models.warnings[0]).toContain("designModel");
  });

  test("an empty or blank pattern is ignored, not treated as a model named ''", () => {
    expect(parseDevStageModels('{"designModel": ""}').design).toBeUndefined();
    expect(parseDevStageModels('{"designModel": "   "}').design).toBeUndefined();
    expect(parseDevStageModels('{"designModel": ""}').warnings).toHaveLength(1);
  });

  test("a pattern containing whitespace is a typo, not a model id", () => {
    const models = parseDevStageModels('{"workerModel": "kimi k3 fast"}');
    expect(models.worker).toBeUndefined();
    expect(models.warnings[0]).toContain("workerModel");
  });

  // The realistic mistake. Silently doing nothing would leave the user
  // convinced they had configured a tier they had not.
  test("a misspelled key warns instead of vanishing", () => {
    const models = parseDevStageModels('{"designmodel": "a/b:high"}');
    expect(models.design).toBeUndefined();
    expect(models.warnings).toHaveLength(1);
    expect(models.warnings[0]).toContain("unknown key");
    expect(models.warnings[0]).toContain("designmodel");
  });

  test("an unknown key alongside a good one keeps the good one", () => {
    const models = parseDevStageModels('{"designModel": "a/b:high", "notes": "why"}');
    expect(models.design).toBe("a/b:high");
    expect(models.warnings).toHaveLength(1);
  });

  test("no input shape throws", () => {
    for (const raw of ["", " ", "{", "}", "[1,2", " ", "{\"a\":", "undefined"]) {
      expect(() => parseDevStageModels(raw)).not.toThrow();
    }
  });
});

// The script that WRITES the file and the module that READS it are two
// spellings of one schema, in two languages, in different directories. The
// realistic drift is the script gaining a third key or renaming one, which
// would produce a config the reader silently warns about at 1am.
describe("dogfood-reset writes the schema this module reads", () => {
  const script = readFileSync(
    join(import.meta.dirname, "..", "..", "scripts", "dogfood", "reset"),
    "utf8",
  );

  test("it writes the tier file to the path the reader reads", () => {
    expect(script).toContain(DEV_STAGE_MODELS_RELATIVE.split("/").pop());
    expect(script).toContain("dev-stage-models.json");
  });

  test("the JSON keys it emits are exactly the reader's keys", () => {
    const emitted = [...script.matchAll(/\\"([A-Za-z_]+Model)\\":/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(0);
    expect([...new Set(emitted)].sort()).toEqual(Object.values(TIER_KEY).sort());
  });

  test("the flags that set them are named in its usage block", () => {
    const usage = script.slice(0, script.indexOf("set -euo pipefail"));
    expect(usage).toContain("--design-model");
    expect(usage).toContain("--worker-model");
  });
});
