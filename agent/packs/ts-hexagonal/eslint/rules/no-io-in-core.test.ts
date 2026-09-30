import { afterAll, describe, expect, it, test } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { isIoModule, noIoInCore } from "./no-io-in-core.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const C = "contexts/project-management/src";
const DOMAIN = `${C}/domain/notes/note-text.ts`;
const HANDLER = `${C}/application/notes/create-note/create-note.handler.ts`;
const at = (filename: string, code: string) => ({ code, filename });
const bad = (filename: string, code: string, messageId: "module" | "member" | "unchecked", errors = 1) => ({
  code, filename, errors: Array.from({ length: errors }, () => ({ messageId })),
});

ruleTester.run("no-io-in-core", noIoInCore, {
  valid: [
    at(DOMAIN, `import { z } from "zod";\nexport const s = z.string();`),
    at(HANDLER, `import type * as Contract from "./create-note.contract.ts";\nexport type X = Contract.CreateNote;`),
    // Type-only imports are erased: they load nothing.
    at(DOMAIN, `import type { Stats } from "node:fs";\nexport type S = Stats;`),
    // Members of the globals that reach no I/O.
    at(DOMAIN, `export const argv = process.argv.length;`),
    at(DOMAIN, `export const v = Bun.version;`),
    // A property or member that merely shares the name.
    at(DOMAIN, `export const o = { process: 1, Bun: 2 };\nexport const p = o.process + o.Bun;`),
    at(DOMAIN, `export class Job { process(): void {} }`),
    // Out adapters, apps and tests are where I/O lives.
    at(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, `import { readFileSync } from "node:fs";\nexport const e = process.env.X;`),
    at("apps/web/src/server/main.ts", `export const port = process.env.PORT;\nexport const f = Bun.file("x");`),
    at(`${C}/domain/notes/note-text.test.ts`, `import { readFileSync } from "node:fs";\nexport const e = process.env.X;`),
    at(`${C}/application/notes/create-note/create-note.store.test-support.ts`, `export const f = Bun.file("x");`),
  ],
  invalid: [
    // Every module that does I/O, in every loading form.
    bad(DOMAIN, `import { readFileSync } from "node:fs";`, "module"),
    bad(DOMAIN, `import * as fs from 'fs';`, "module"),
    bad(DOMAIN, `import { readFile } from "fs/promises";`, "module"),
    bad(DOMAIN, `import { type Stats } from "node:fs";`, "module"),
    bad(HANDLER, `import { spawn } from "node:child_process";`, "module"),
    bad(HANDLER, `import { connect } from "node:net";`, "module"),
    bad(HANDLER, `import { file } from "bun";`, "module"),
    bad(HANDLER, `import { Database } from "bun:sqlite";`, "module"),
    bad(HANDLER, `import "node:fs";`, "module"),
    bad(HANDLER, `export { readFileSync } from "node:fs";`, "module"),
    bad(HANDLER, `export const m = () => import("node:fs");`, "module"),
    bad(HANDLER, `export const m = require("child_process");`, "module"),
    bad(HANDLER, "export const m = import(`node:net`);", "module"),
    // The runtime globals, directly and through a global object.
    bad(DOMAIN, `export const f = Bun.file("x");`, "member"),
    bad(DOMAIN, `export const w = () => Bun.write("x", "y");`, "member"),
    bad(DOMAIN, `export const s = () => Bun.spawn(["ls"]);`, "member"),
    bad(DOMAIN, `export const s = () => Bun.spawnSync(["ls"]);`, "member"),
    bad(DOMAIN, `export const e = process.env.SECRET;`, "member"),
    bad(DOMAIN, `export const e = process["env"];`, "member"),
    bad(DOMAIN, `export const f = Bun["file"]("x");`, "member"),
    bad(DOMAIN, `export const e = process?.env;`, "member"),
    bad(DOMAIN, `export const f = globalThis.Bun.file("x");`, "member"),
    bad(DOMAIN, `export const e = globalThis["process"].env;`, "member"),
    // Uses the check cannot see through: fail closed.
    bad(DOMAIN, `const { env } = process;\nexport { env };`, "unchecked"),
    bad(DOMAIN, `const B = Bun;\nexport const f = B.file("x");`, "unchecked"),
    bad(DOMAIN, `const k = "env";\nexport const e = process[k];`, "unchecked"),
    bad(DOMAIN, `export const o = { process };`, "unchecked"),
    bad(DOMAIN, `const g = globalThis;\nexport const e = g.process;`, "unchecked"),
    bad(DOMAIN, `const k = "Bun";\nexport const e = globalThis[k];`, "unchecked"),
  ],
});

describe("isIoModule", () => {
  test("the named modules, with or without node:, and their subpaths; nothing else", () => {
    for (const spec of ["fs", "node:fs", "fs/promises", "node:fs/promises", "child_process", "node:child_process", "net", "node:net", "bun", "bun:sqlite"]) {
      expect(isIoModule(spec), spec).toBe(true);
    }
    for (const spec of ["zod", "fsx", "netlify", "./fs.ts", "@scope/fs", "bunyan", "node:path"]) {
      expect(isIoModule(spec), spec).toBe(false);
    }
  });
});
