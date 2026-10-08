import { describe, expect, test } from "bun:test";
import { wireOf } from "../shared/value-object.laws.test-support.ts";
import { Effect } from "./effect.ts";
import { ShellCommandReading } from "./shell-command-reading.ts";

const EMPTY_READ = { outcome: "read", programs: [], fileEffects: [], unresolved: [] };
const FORM = "A shell command reading is { outcome: 'read', programs, fileEffects, unresolved } or { outcome: 'unread', why }";

const error = (raw: unknown): string | undefined => {
  const result = ShellCommandReading.parse(raw);
  return result.ok ? undefined : result.error;
};
const read = (raw: unknown) => {
  const result = ShellCommandReading.parse(raw);
  if (!result.ok) throw new Error(result.error);
  if (result.value.outcome !== "read") throw new Error("expected a read reading");
  return result.value;
};

describe("ShellCommandReading — what bounded made of a shell command", () => {
  test("a reading lists the programs a command runs, each with its words and where it runs, null where that cannot be known", () => {
    const reading = read({
      ...EMPTY_READ,
      programs: [
        { name: { kind: "literal", text: "cd" }, arguments: [{ kind: "unresolved", text: "$DIR" }], workingDirectory: "./apps//web" },
        { name: { kind: "unresolved", text: "$TOOL" }, arguments: [{ kind: "literal", text: "" }], workingDirectory: null },
      ],
    });
    expect(reading.programs.map((program) => [program.name.kind, program.name.text, program.arguments.map((word) => word.text), program.workingDirectory?.value ?? null])).toEqual([
      ["literal", "cd", ["$DIR"], "apps/web"],
      ["unresolved", "$TOOL", [""], null],
    ]);
    expect(error({ ...EMPTY_READ, programs: [{ name: { kind: "glob", text: "*" }, arguments: [], workingDirectory: null }] })).toBe("A shell word is { kind: 'literal' or 'unresolved', text }");
    expect(error({ ...EMPTY_READ, programs: [{ name: { kind: "literal", text: "cat" }, arguments: [] }] })).toBe("A program a shell command runs is { name, arguments, workingDirectory }");
    expect(error({ ...EMPTY_READ, programs: [{ name: { kind: "literal", text: "cat" }, arguments: [], workingDirectory: "../x" }] })).toBe("Path '../x' climbs out of the project with '..'. Only paths inside the project can be checked");
  });

  test("a reading's file effects are reads, lists and writes in the effects' own vocabulary", () => {
    const wires = [{ kind: "read", path: "a.txt" }, { kind: "list", root: "src", filter: null }, { kind: "write", path: "b.txt", change: "delete" }];
    const reading = read({ ...EMPTY_READ, fileEffects: wires.map((effect) => ({ effect })) });
    for (const [index, wire] of wires.entries()) {
      const effect = Effect.parse(wire);
      expect(effect.ok && reading.fileEffects[index]?.effect.equals(effect.value)).toBe(true);
    }
    expect(error({ ...EMPTY_READ, fileEffects: [{ effect: { kind: "fetch", url: "https://example.com" } }] })).toBe("A shell command reading's file effects are reads, lists and writes, not 'fetch'");
    expect(error({ ...EMPTY_READ, fileEffects: [{ effect: { kind: "read", path: "a.txt" }, also: 1 }] })).toBe("A shell command reading's file effect is { effect, existenceUnknown? }");
  });

  test("existence unknown marks only a create or a modify", () => {
    const reading = read({ ...EMPTY_READ, fileEffects: [{ effect: { kind: "write", path: "a.txt", change: "create" }, existenceUnknown: true }, { effect: { kind: "write", path: "a.txt", change: "modify" }, existenceUnknown: false }] });
    expect(reading.fileEffects[0]?.existenceUnknown).toBe(true);
    expect(reading.fileEffects[1]?.existenceUnknown).toBeUndefined();
    expect(wireOf(reading)).toEqual({ ...EMPTY_READ, fileEffects: [{ effect: { kind: "write", path: "a.txt", change: "create" }, existenceUnknown: true }, { effect: { kind: "write", path: "a.txt", change: "modify" } }] });
    expect(error({ ...EMPTY_READ, fileEffects: [{ effect: { kind: "write", path: "a.txt", change: "delete" }, existenceUnknown: true }] })).toBe("Only a create or a modify can have an unknown existence");
    expect(error({ ...EMPTY_READ, fileEffects: [{ effect: { kind: "read", path: "a.txt" }, existenceUnknown: true }] })).toBe("Only a create or a modify can have an unknown existence");
  });

  test("an unresolved part names its text and the role it would have had", () => {
    const reading = read({ ...EMPTY_READ, unresolved: ["read", "list", "write", "directory", "code"].map((role) => ({ text: "$X", role })) });
    expect(reading.unresolved.map((part) => part.role)).toEqual(["read", "list", "write", "directory", "code"]);
    expect(error({ ...EMPTY_READ, unresolved: [{ text: "", role: "read" }] })).toBe("An unresolved part names the text that could not be resolved");
    expect(error({ ...EMPTY_READ, unresolved: [{ text: "$X", role: "run" }] })).toBe("An unresolved part's role is read, list, write, directory or code, not 'run'");
  });

  test("an unread reading says why", () => {
    const parsed = ShellCommandReading.parse({ outcome: "unread", why: "the parser could not load" });
    expect(parsed.ok && parsed.value.outcome === "unread" && parsed.value.why).toBe("the parser could not load");
    expect(error({ outcome: "unread", why: " " })).toBe("An unread reading says why it could not be read");
    expect(error({ outcome: "unread" })).toBe(FORM);
  });

  test("a reading is { outcome: 'read', programs, fileEffects, unresolved } or { outcome: 'unread', why }", () => {
    for (const raw of [{ outcome: "maybe" }, { ...EMPTY_READ, extra: true }, { outcome: "read", programs: [] }, { outcome: "unread", why: "x", programs: [] }, "read", null]) expect(error(raw)).toBe(FORM);
    expect(error({ ...EMPTY_READ, programs: "cat" })).toBe("A shell command reading's programs, fileEffects and unresolved are lists");
  });

  test("an unread reading may say what made it unreadable: too complex or unparsable; without a cause its wire form has none", () => {
    for (const cause of ["too-complex", "unparsable"] as const) {
      const parsed = ShellCommandReading.parse({ outcome: "unread", why: "x", cause });
      expect(parsed.ok && parsed.value.outcome === "unread" && parsed.value.cause).toBe(cause);
      expect(wireOf(parsed)).toEqual({ ok: true, value: { outcome: "unread", why: "x", cause } });
    }
    const plain = ShellCommandReading.parse({ outcome: "unread", why: "x" });
    expect(plain.ok && Object.keys(plain.value.toJSON())).toEqual(["outcome", "why"]);
    expect(error({ outcome: "unread", why: "x", cause: "slow" })).toBe("An unread reading's cause is too-complex or unparsable, not 'slow'");
  });

  test("is frozen, its lists and entries too", () => {
    const reading = read({ ...EMPTY_READ, programs: [{ name: { kind: "literal", text: "cat" }, arguments: [], workingDirectory: "." }], fileEffects: [{ effect: { kind: "read", path: "a.txt" } }], unresolved: [{ text: "$X", role: "read" }] });
    expect([reading, reading.programs, reading.programs[0], reading.programs[0]?.name, reading.programs[0]?.arguments, reading.fileEffects, reading.fileEffects[0], reading.unresolved, reading.unresolved[0]].every(Object.isFrozen)).toBe(true);
  });
});
