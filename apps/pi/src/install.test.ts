import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { piLoader } from "./install.ts";

describe("piLoader — the file pi loads as the project's bounded extension", () => {
  test("lives where pi discovers project extensions", () => {
    expect(piLoader().path).toBe(".pi/extensions/bounded/index.ts");
  });

  test("is the same every time: it names no machine, user or absolute path", () => {
    expect(piLoader()).toEqual(piLoader());
    expect(piLoader().content).not.toMatch(/\/(Users|home|tmp|var)\//);
    expect(piLoader().content).toContain('from "bounded-pi"');
  });

  test("default-exports bounded-pi's extension for the project it sits in", () => {
    // A stand-in bounded-pi whose extension reports the root it was given.
    const project = realpathSync(mkdtempSync(join(tmpdir(), "bounded-pi-install-")));
    const stub = join(project, "node_modules", "bounded-pi");
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "bounded-pi", type: "module", exports: { ".": "./index.js" } }));
    writeFileSync(join(stub, "index.js"), "export const bounded = (root) => () => root;\n");
    const loader = piLoader();
    mkdirSync(dirname(join(project, loader.path)), { recursive: true });
    writeFileSync(join(project, loader.path), loader.content);

    // Loaded by a separate bun process, as pi would load it from the project.
    writeFileSync(join(project, "load.ts"), `import extension from "./${loader.path}";\nconsole.log(extension());\n`);
    const run = Bun.spawnSync(["bun", "load.ts"], { cwd: project });
    expect(run.stderr.toString()).toBe("");
    expect(run.stdout.toString().trim()).toBe(project);
  });
});
