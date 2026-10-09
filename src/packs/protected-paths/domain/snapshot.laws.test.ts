import { valueObjectLaws } from "../../../core/domain/shared/value-object.laws.test-support.ts";
import { Snapshot } from "./snapshot.ts";

const A = "a".repeat(64);
/** Parsed as watched by two rules. */
const twoRules = { parse: (raw: unknown) => Snapshot.parse(raw, 2) };

valueObjectLaws(
  "Snapshot",
  twoRules,
  [
    { commit: "c0", files: { "a.ts": { hash: A, size: 1, rule: 0, kept: { from: "commit" } } } },
    { commit: null, files: { "b.ts": { hash: A, size: 2, rule: 1, rules: [0, 1], kept: { from: "copy", content: "YWI=", executable: false } } } },
  ],
  [{ commit: 1, files: {} }, { commit: null, files: { "a.ts": { hash: "x" } } }],
);
