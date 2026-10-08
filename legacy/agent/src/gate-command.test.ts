import { describe, expect, test } from "vitest";
import {
  argBoolean,
  argJson,
  argNumber,
  argString,
  argStrings,
  isGateCommand,
  isGateRegistry,
  parseGateArgs,
  type FlagSpec,
} from "./gate-command.ts";

// The flag grammar every pack's gates are invoked through (ADR 2026-029). It
// is strict on purpose: the CLI turns any error into usage (exit 64) rather
// than guessing what a mistyped flag meant.

const SPECS: readonly FlagSpec[] = [
  { name: "pattern", kind: "string", repeatable: true, description: "glob" },
  { name: "write", kind: "boolean", description: "record" },
  { name: "max-mutants", kind: "number", description: "cap" },
  { name: "findings", kind: "json", description: "payload" },
  { name: "role", kind: "string", description: "role" },
];

describe("parseGateArgs", () => {
  test("positionals, booleans, and both value spellings", () => {
    const r = parseGateArgs(SPECS, ["proj", "--write", "--max-mutants", "5", "--role=builder"]);
    expect(r).toEqual({
      ok: true,
      positionals: ["proj"],
      args: { write: true, "max-mutants": 5, role: "builder" },
    });
  });

  test("a repeatable flag collects a list; a lone value is still a list", () => {
    const r = parseGateArgs(SPECS, ["--pattern", "a/**", "--pattern=b/**"]);
    expect(r.ok && r.args["pattern"]).toEqual(["a/**", "b/**"]);
    const one = parseGateArgs(SPECS, ["--pattern", "a/**"]);
    expect(one.ok && one.args["pattern"]).toEqual(["a/**"]);
  });

  test("json parses to a value; null is a given value, not an absence", () => {
    const r = parseGateArgs(SPECS, ["--findings", '[{"severity":"note"}]']);
    expect(r.ok && r.args["findings"]).toEqual([{ severity: "note" }]);
    const n = parseGateArgs(SPECS, ["--findings", "null"]);
    expect(n.ok && "findings" in n.args).toBe(true);
    expect(n.ok && argJson(n.args, "findings")).toBeNull();
  });

  test.each([
    [["--bogus"], /unknown flag --bogus/],
    [["--role"], /--role needs a value/],
    [["--write=yes"], /--write takes no value/],
    [["--max-mutants", "many"], /--max-mutants needs a number/],
    [["--max-mutants="], /--max-mutants needs a number/],
    [["--findings", "{nope"], /--findings is not valid JSON/],
    [["--role", "a", "--role", "b"], /--role given more than once/],
  ])("%j is an error, not a guess", (argv, message) => {
    const r = parseGateArgs(SPECS, argv);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(message);
  });
});

describe("typed accessors narrow what the parser produced", () => {
  const parsed = parseGateArgs(SPECS, ["--write", "--max-mutants=3", "--pattern", "x", "--role", "r"]);
  const args = parsed.ok ? parsed.args : {};

  test("present values come back typed; absent ones as undefined/false/[]", () => {
    expect(argBoolean(args, "write")).toBe(true);
    expect(argBoolean(args, "nope")).toBe(false);
    expect(argNumber(args, "max-mutants")).toBe(3);
    expect(argNumber(args, "role")).toBeUndefined();
    expect(argString(args, "role")).toBe("r");
    expect(argString(args, "max-mutants")).toBeUndefined();
    expect(argStrings(args, "pattern")).toEqual(["x"]);
    expect(argStrings(args, "nope")).toEqual([]);
    expect(argJson(args, "findings")).toBeUndefined();
  });
});

describe("runtime shape checks (the registry arrives through a dynamic import)", () => {
  const command = {
    name: "x",
    tool: "x_tool",
    description: "d",
    flags: SPECS,
    promptGuidelines: ["g"],
    run: async () => ({ code: 0, verdict: "pass", summary: "", lines: [], detail: {} }),
  };

  test("accepts a well-formed command, with or without a tool", () => {
    expect(isGateCommand(command)).toBe(true);
    expect(isGateCommand({ ...command, tool: undefined })).toBe(true);
    expect(isGateRegistry([command])).toBe(true);
  });

  test("rejects a malformed flag, a missing run, or a non-array", () => {
    expect(isGateCommand({ ...command, flags: [{ name: "f", kind: "list", description: "" }] })).toBe(false);
    expect(isGateCommand({ ...command, run: undefined })).toBe(false);
    expect(isGateRegistry({ gates: [] })).toBe(false);
    expect(isGateRegistry([command, {}])).toBe(false);
  });
});
