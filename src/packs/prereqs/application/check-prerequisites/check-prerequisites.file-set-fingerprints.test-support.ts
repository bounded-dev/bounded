import { describe, expect, test } from "bun:test";
import { FileSetFingerprint } from "../../domain/file-set-fingerprint.ts";
import type { FileSetFingerprints } from "./check-prerequisites.contract.ts";

/** A FileSetFingerprints over a project whose files a test can write and remove. */
export interface FileSetFingerprintsHarness {
  readonly fingerprints: FileSetFingerprints;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** The fingerprint an adapter gave, parsed; a test failure when it gave none. */
async function fingerprintOf(fingerprints: FileSetFingerprints, patterns: readonly string[]): Promise<FileSetFingerprint> {
  const given = await fingerprints.fingerprint(patterns);
  if (!given.ok) throw new Error(given.error);
  const parsed = FileSetFingerprint.parse(given.value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/**
 * The behaviour every FileSetFingerprints must have: the same files give the
 * same fingerprint, any change to a matching file changes it, nothing else
 * does; matching ignores case and sees dotfiles, a glob-free pattern covers
 * what is under it, and Bounded's state, node_modules and .git never count.
 */
export function fileSetFingerprintsConformance(name: string, fixture: (files: Readonly<Record<string, string>>) => Promise<FileSetFingerprintsHarness>): void {
  describe(`${name} conforms to FileSetFingerprints`, () => {
    const project = { "spec.md": "the spec\n", "src/a.contract.ts": "export interface A {}\n", "src/a.ts": "export const a = 1;\n", "docs/notes.md": "notes\n" };
    const patterns = ["spec.md", "src/**/*.contract.ts"];

    test("the same files give the same fingerprint, counting each matching file", async () => {
      const { fingerprints } = await fixture(project);
      const first = await fingerprintOf(fingerprints, patterns);
      const again = await fingerprintOf(fingerprints, patterns);
      expect(first.equals(again)).toBe(true);
      expect(first.fileCount).toBe(2);
      expect((await fingerprintOf(fingerprints, ["src/**"])).fileCount).toBe(2);
    });

    test("a changed byte, or an added or removed matching file, changes it; a file that does not match does not", async () => {
      const harness = await fixture(project);
      const before = await fingerprintOf(harness.fingerprints, patterns);
      await harness.write("docs/notes.md", "other notes\n");
      await harness.write("src/a.ts", "export const a = 2;\n");
      expect((await fingerprintOf(harness.fingerprints, patterns)).equals(before)).toBe(true);
      await harness.write("spec.md", "the spec!\n");
      const changed = await fingerprintOf(harness.fingerprints, patterns);
      expect(changed.equals(before)).toBe(false);
      await harness.write("spec.md", "the spec\n");
      expect((await fingerprintOf(harness.fingerprints, patterns)).equals(before)).toBe(true);
      await harness.write("src/b/b.contract.ts", "export interface B {}\n");
      const added = await fingerprintOf(harness.fingerprints, patterns);
      expect(added.equals(before)).toBe(false);
      expect(added.fileCount).toBe(3);
      await harness.remove("src/b/b.contract.ts");
      await harness.remove("src/a.contract.ts");
      const removed = await fingerprintOf(harness.fingerprints, patterns);
      expect(removed.equals(before)).toBe(false);
      expect(removed.fileCount).toBe(1);
    });

    test("a file moved to another matching path changes it", async () => {
      const harness = await fixture({ "src/a.contract.ts": "same\n" });
      const before = await fingerprintOf(harness.fingerprints, ["src/**"]);
      await harness.remove("src/a.contract.ts");
      await harness.write("src/b.contract.ts", "same\n");
      expect((await fingerprintOf(harness.fingerprints, ["src/**"])).equals(before)).toBe(false);
    });

    test("matching ignores case and sees dotfiles; a glob-free pattern covers what is under it", async () => {
      const { fingerprints } = await fixture({ "Infra/main.tf": "a", "infra/modules/.hidden.tf": "b", ".agent-state/x/plan.md": "c", "infrastructure/other.tf": "d" });
      expect((await fingerprintOf(fingerprints, ["infra"])).fileCount).toBe(2);
      expect((await fingerprintOf(fingerprints, ["INFRA/**/*.tf"])).fileCount).toBe(2);
      expect((await fingerprintOf(fingerprints, [".agent-state/*/plan.md"])).fileCount).toBe(1);
    });

    test("Bounded's state, node_modules and .git never count", async () => {
      const { fingerprints } = await fixture({ "src/a.ts": "a", ".bounded/prereqs/records.jsonl": "{}\n", "node_modules/x/index.js": "x", "src/node_modules/y.js": "y", ".git/HEAD": "ref" });
      expect((await fingerprintOf(fingerprints, ["**"])).fileCount).toBe(1);
    });

    test("patterns that match nothing give a count of 0", async () => {
      const { fingerprints } = await fixture(project);
      const none = await fingerprintOf(fingerprints, ["missing/**"]);
      expect(none.fileCount).toBe(0);
      expect(none.isEmpty()).toBe(true);
    });
  });
}
