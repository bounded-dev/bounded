import { describe, expect, test } from "bun:test";
import { FileSetFingerprint } from "./file-set-fingerprint.ts";

const A = "a".repeat(64);
const error = (raw: unknown): string | undefined => {
  const parsed = FileSetFingerprint.parse(raw);
  return parsed.ok ? undefined : parsed.error;
};

describe("FileSetFingerprint — what a set of files held, in one hash", () => {
  test("a fingerprint is a SHA-256 in lowercase hex and a count of files", () => {
    const parsed = FileSetFingerprint.parse({ sha256: A, fileCount: 3 });
    expect(parsed.ok && parsed.value.sha256).toBe(A);
    expect(parsed.ok && parsed.value.fileCount).toBe(3);
    expect(parsed.ok && parsed.value.toJSON()).toEqual({ sha256: A, fileCount: 3 });
    expect(error({ sha256: A.toUpperCase(), fileCount: 3 })).toBe("A file-set fingerprint's sha256 is a SHA-256 in lowercase hex");
    expect(error({ sha256: "abc", fileCount: 3 })).toBe("A file-set fingerprint's sha256 is a SHA-256 in lowercase hex");
    for (const fileCount of [-1, 1.5, "3", null]) expect(error({ sha256: A, fileCount })).toBe("A file-set fingerprint's fileCount is a whole number of files, 0 or more");
    for (const raw of [null, "x", [], { sha256: A }, { sha256: A, fileCount: 1, extra: true }]) expect(error(raw)).toBe("A file-set fingerprint is { sha256, fileCount }");
  });

  test("a fingerprint over no files is empty", () => {
    const none = FileSetFingerprint.parse({ sha256: A, fileCount: 0 });
    const some = FileSetFingerprint.parse({ sha256: A, fileCount: 1 });
    expect(none.ok && none.value.isEmpty()).toBe(true);
    expect(some.ok && some.value.isEmpty()).toBe(false);
  });

  test("equal by hash and count", () => {
    const one = FileSetFingerprint.parse({ sha256: A, fileCount: 1 });
    const same = FileSetFingerprint.parse({ sha256: A, fileCount: 1 });
    const other = FileSetFingerprint.parse({ sha256: "b".repeat(64), fileCount: 1 });
    expect(one.ok && same.ok && one.value.equals(same.value)).toBe(true);
    expect(one.ok && other.ok && one.value.equals(other.value)).toBe(false);
  });
});
