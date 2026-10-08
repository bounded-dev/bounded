import { describe, expect, test } from "bun:test";
import { Snapshot } from "./snapshot.ts";

const A = "a".repeat(64);
const file = (fields: object) => ({ hash: A, size: 1, rule: 0, kept: { from: "commit" }, ...fields });
const error = (raw: unknown, ruleCount = 2): string | undefined => {
  const result = Snapshot.parse(raw, ruleCount);
  return result.ok ? undefined : result.error;
};

describe("Snapshot — boundaries", () => {
  test("the watched files before a command, each with how it can be put back, and the commit", () => {
    const parsed = Snapshot.parse({ commit: "c0", files: { "a.ts": file({}), "b.ts": file({ rule: 1, rules: [0, 1], kept: { from: "copy", content: "Yg==", executable: true } }), "c": file({ link: true, kept: { from: "nowhere" } }) } }, 2);
    expect(parsed.ok && parsed.value.commit).toBe("c0");
    expect(parsed.ok && parsed.value.files["b.ts"]).toEqual({ hash: A, size: 1, rule: 1, rules: [0, 1], kept: { from: "copy", content: "Yg==", executable: true } });
    expect(parsed.ok && Object.isFrozen(parsed.value.files["a.ts"])).toBe(true);
  });

  test("refuses what is not a snapshot", () => {
    for (const raw of [null, [], { commit: 1, files: {} }, { commit: null }, { commit: null, files: [] }]) expect(error(raw)).toBe("it is not a snapshot");
  });

  test("refuses a file whose hash is not a SHA-256, naming it", () => {
    expect(error({ commit: null, files: { "a.ts": file({ hash: "abc" }) } })).toBe("a.ts has a hash that is not a SHA-256");
    expect(error({ commit: null, files: { "a\nb": file({ hash: 5 }) } })).toBe("a\\nb has a hash that is not a SHA-256");
  });

  test("refuses a file whose fields are not a snapshot file's, a rule past the rules included", () => {
    for (const fields of [{ size: -1 }, { rule: 2 }, { rules: [0, 2] }, { rules: "0" }, { link: false }, { kept: null }, { kept: { from: "elsewhere" } }]) {
      expect(error({ commit: null, files: { "a.ts": file(fields) } })).toBe("a.ts is not a snapshot's file");
    }
  });

  test("refuses a copy that is not base64 text with an executable flag", () => {
    expect(error({ commit: null, files: { "a.ts": file({ kept: { from: "copy", content: 5, executable: false } }) } })).toBe("the copy of a.ts does not match its hash");
    expect(error({ commit: null, files: { "a.ts": file({ kept: { from: "copy", content: "YQ==" } }) } })).toBe("the copy of a.ts does not match its hash");
  });

  test("a snapshot it parsed parses again to an equal one; its wire form is plain data", () => {
    const parsed = Snapshot.parse({ commit: null, files: { "a.ts": file({}) } }, 1);
    expect(parsed.ok && JSON.parse(JSON.stringify(parsed.value))).toEqual({ commit: null, files: { "a.ts": file({}) } });
    expect(parsed.ok && Snapshot.parse(parsed.value, 1)).toEqual(parsed);
  });
});
