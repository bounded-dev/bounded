import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ShellCommandReading } from "./shell-command-reading.ts";

const READ_SAMPLE = {
  outcome: "read",
  programs: [{ name: { kind: "literal", text: "cat" }, arguments: [{ kind: "literal", text: ".env" }, { kind: "unresolved", text: "$X" }], workingDirectory: "." }],
  fileEffects: [
    { effect: { kind: "read", path: ".env" } },
    { effect: { kind: "write", path: "out.txt", change: "create" }, existenceUnknown: true },
    { effect: { kind: "write", path: "out.txt", change: "modify" }, existenceUnknown: true },
  ],
  unresolved: [{ text: "$X", role: "read" }],
};
const UNREAD_SAMPLE = { outcome: "unread", why: "the parser could not load" };
const EMPTY_READ = { outcome: "read", programs: [], fileEffects: [], unresolved: [] };

valueObjectLaws(
  "ShellCommandReading",
  ShellCommandReading,
  [READ_SAMPLE, UNREAD_SAMPLE, EMPTY_READ, { outcome: "unread", why: "the command is too complex to read", cause: "too-complex" }],
  [
    { outcome: "maybe" },
    { outcome: "unread", why: " " },
    { ...EMPTY_READ, fileEffects: [{ effect: { kind: "fetch", url: "https://example.com" } }] },
    { ...EMPTY_READ, fileEffects: [{ effect: { kind: "read", path: "a.txt" }, existenceUnknown: true }] },
    { ...EMPTY_READ, unresolved: [{ text: "$X", role: "run" }] },
    { ...EMPTY_READ, programs: [{ name: { kind: "literal", text: "cat" }, arguments: [], workingDirectory: "../x" }] },
    { ...EMPTY_READ, extra: true },
    { outcome: "unread", why: "x", cause: "slow" },
  ],
);
