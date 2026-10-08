import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileSetFingerprintsConformance } from "../../../application/check-prerequisites/check-prerequisites.file-set-fingerprints.test-support.ts";
import { FileSystemFileSetFingerprints } from "./file-set-fingerprints.ts";

function projectWith(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "prereqs-fingerprints-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

fileSetFingerprintsConformance("FileSystemFileSetFingerprints", async (files) => {
  const root = projectWith(files);
  return {
    fingerprints: new FileSystemFileSetFingerprints(root),
    write: async (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
    remove: async (path) => rmSync(join(root, path)),
  };
});

describe("FileSystemFileSetFingerprints — the project's files on disk", () => {
  test("a gitignored file counts", async () => {
    const root = projectWith({ ".gitignore": ".agent-state/\n", ".agent-state/x/plan.md": "the plan\n" });
    spawnSync("git", ["init", "--quiet"], { cwd: root });
    const fingerprint = await new FileSystemFileSetFingerprints(root).fingerprint([".agent-state/*/plan.md"]);
    expect(fingerprint).toMatchObject({ ok: true, value: { fileCount: 1 } });
  });

  test("a link matching the patterns cannot be fingerprinted: the error names it", async () => {
    const root = projectWith({ "outside.md": "elsewhere\n", "docs/real.md": "real\n" });
    symlinkSync("../outside.md", join(root, "docs", "linked.md"));
    const fingerprints = new FileSystemFileSetFingerprints(root);
    const linked = await fingerprints.fingerprint(["docs/**"]);
    expect(linked.ok).toBe(false);
    expect(!linked.ok && linked.error).toContain("docs/linked.md is a symbolic link");
    // A linked directory the patterns could reach into fails the same way.
    mkdirSync(join(root, "elsewhere"));
    symlinkSync("../elsewhere", join(root, "docs", "more"));
    const reached = await fingerprints.fingerprint(["docs/more/*.md"]);
    expect(!reached.ok && reached.error).toContain("docs/more is a symbolic link");
    // A link the patterns cannot reach changes nothing.
    expect(await fingerprints.fingerprint(["docs/real.md"])).toMatchObject({ ok: true, value: { fileCount: 1 } });
    writeFileSync(join(root, "outside.md"), "changed\n");
    expect((await fingerprints.fingerprint(["docs/**"])).ok).toBe(false);
  });

  test("a link to a file is ignored unless its own path matches the patterns", async () => {
    // The final review's repro: a script alias must not stop a fingerprint of the project's Markdown.
    const root = projectWith({ "README.md": "readme\n", "docs/a.md": "a\n", "tools/run.sh": "echo run\n" });
    symlinkSync("run.sh", join(root, "tools", "alias.sh"));
    const fingerprints = new FileSystemFileSetFingerprints(root);
    expect(await fingerprints.fingerprint(["**/*.md"])).toMatchObject({ ok: true, value: { fileCount: 2 } });
    // A link whose own path matches still refuses, naming it.
    symlinkSync("../README.md", join(root, "docs", "readme-alias.md"));
    const matching = await fingerprints.fingerprint(["**/*.md"]);
    expect(!matching.ok && matching.error).toContain("docs/readme-alias.md is a symbolic link");
  });

  test("an entry the patterns match that is neither a file, a directory nor a link refuses; one they do not match is ignored", async () => {
    const root = projectWith({ "docs/a.md": "a\n" });
    expect(spawnSync("mkfifo", [join(root, "docs", "pipe")]).status).toBe(0);
    const fingerprints = new FileSystemFileSetFingerprints(root);
    expect(await fingerprints.fingerprint(["docs/*.md"])).toMatchObject({ ok: true, value: { fileCount: 1 } });
    const named = await fingerprints.fingerprint(["docs/**"]);
    expect(named.ok).toBe(false);
    expect(!named.ok && named.error).toContain("docs/pipe is neither a file, a directory nor a link");
  });

  test("a pattern that is not one is refused, naming it", async () => {
    const fingerprint = await new FileSystemFileSetFingerprints(projectWith({})).fingerprint(["../outside/**"]);
    expect(fingerprint.ok).toBe(false);
    expect(!fingerprint.ok && fingerprint.error).toContain("'../outside/**'");
  });

  test("a project that cannot be read is an error, never an empty set", async () => {
    const fingerprint = await new FileSystemFileSetFingerprints(join(tmpdir(), "prereqs-no-such-project", String(Date.now()))).fingerprint(["**"]);
    expect(fingerprint.ok).toBe(false);
  });

  test("fingerprints 2,000 files well within pi's deadline", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) files[`src/m${i % 40}/f${i}.ts`] = `export const v${i} = ${i};\n`;
    const fingerprints = new FileSystemFileSetFingerprints(projectWith(files));
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      expect(await fingerprints.fingerprint(["src/**"])).toMatchObject({ ok: true, value: { fileCount: 2000 } });
      times.push(performance.now() - started);
    }
    const median = [...times].sort((a, b) => a - b)[2] ?? Number.POSITIVE_INFINITY;
    console.log(`fingerprint of 2,000 files: median ${median.toFixed(0)} ms`);
    expect(median).toBeLessThan(1000);
  });
});
