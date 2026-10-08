import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { testImports } from "./test-imports.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const options = [{
  workspaces: {
    "@example/project-management": "contexts/project-management",
    "@example/billing": "contexts/billing",
    "@example/web": "apps/web",
  },
}] as const;

const C = "contexts/project-management/src";
const ok = (filename: string, code: string) => ({ code, filename, options });
const bad = (filename: string, code: string, messageId: "problem" | "placement" = "problem") => ({
  code, filename, options, errors: [{ messageId }],
});

// A project on disk, so the fix can name the concept files a domain test
// should import instead of the barrel.
const root = mkdtempSync(join(tmpdir(), "test-imports-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const [area, stem] of [["notes", "note-text"], ["projects", "project-id"]] as const) {
  mkdirSync(join(root, C, "domain", area), { recursive: true });
  writeFileSync(join(root, C, "domain", area, `${stem}.contract.ts`), "export {};\n");
}

ruleTester.run("test-imports", testImports, {
  valid: [
    // The reference's shapes, level by level.
    ok(`${C}/domain/notes/note.test.ts`, `import { NoteText } from "./note-text.ts";\nimport { ProjectId } from "../projects/project-id.ts";`),
    ok(`${C}/application/notes/create-note/create-note.test.ts`, [
      `import { Note, ProjectId } from "@example/project-management/domain";`,
      `import { CreateNoteCommand } from "./create-note.command.ts";`,
      `import type { CreateNoteStore } from "./create-note.contract.ts";`,
      `import { CreateNoteHandler } from "./create-note.handler.ts";`,
    ].join("\n")),
    ok(`${C}/adapters/out/in-memory/notes/create-note.store.test.ts`, [
      `import { createNoteStoreConformance } from "../../../../application/notes/create-note/create-note.store.test-support.ts";`,
      `import { InMemoryDatabase } from "../in-memory-database.ts";`,
      `import { InMemoryCreateProjectStore } from "../projects/create-project.store.ts";`,
    ].join("\n")),
    ok(`${C}/adapters/out/console/projects/export-projects.exporter.test.ts`, `import { Project } from "@example/project-management/domain";`),
    ok("apps/web/src/server/composition-root.test.ts", `import { composeApp } from "./composition-root.ts";`),
    // Tests may use any library, unlike domain and application code.
    ok(`${C}/domain/notes/note.test.ts`, `import { describe, expect, test } from "bun:test";`),
    // Not a test: the builder's boundary rules answer for it.
    ok(`${C}/domain/notes/note.ts`, `import { NoteText } from "@example/project-management/domain";`),
  ],
  invalid: [
    // The 2026-10-01 dogfood: a domain test through the package barrel.
    bad(`${C}/domain/notes/note-text.test.ts`, `import { NoteText } from "@example/project-management/domain";`),
    bad(`${C}/domain/notes/note-text.test.ts`, `import type { NoteText } from "@example/project-management/domain";`),
    bad(`${C}/application/notes/create-note/create-note.test.ts`, `import { CreateNoteHandler } from "@example/project-management/application";`),
    bad(`${C}/application/notes/create-note/create-note.test.ts`, `import { InMemoryDatabase } from "@example/project-management/adapters/in-memory";`),
    bad(`${C}/domain/notes/note.test.ts`, `import { CreateNoteHandler } from "../../application/notes/create-note/create-note.handler.ts";`),
    bad(`${C}/adapters/out/console/projects/x.exporter.test.ts`, `import { InMemoryDatabase } from "../../in-memory/in-memory-database.ts";`),
    bad(`${C}/domain/notes/note.test.ts`, `import { InvoiceId } from "@example/billing/domain";`),
    bad("apps/web/src/server/x.test.ts", `import { x } from "@example/project-management/src/domain/index.ts";`),
    bad(`${C}/note.test.ts`, `import { expect } from "bun:test";`, "placement"),
  ],
});

ruleTester.run("test-imports names the fix", testImports, {
  valid: [],
  invalid: [
    {
      // A real tree: the fix names each concept's own file.
      code: `import { NoteText, ProjectId, Result } from "@example/project-management/domain";`,
      filename: join(root, C, "domain/notes/note-text.test.ts"),
      options,
      errors: [{
        messageId: "problem" as const,
        data: {
          spec: "@example/project-management/domain",
          detail: "domain files import each other by relative path, never through the package",
          fix: `import each name from its own file by relative path: import { NoteText } from "./note-text.ts"; ` +
            `import { ProjectId } from "../projects/project-id.ts"; import { Result } from "../shared/result.ts";`,
        },
      }],
    },
    {
      code: `import { CreateNoteHandler } from "@example/project-management/application";`,
      filename: `${C}/application/notes/create-note/create-note.test.ts`,
      options,
      errors: [{
        messageId: "problem" as const,
        data: {
          spec: "@example/project-management/application",
          detail: "application files import their own feature's files by relative path",
          fix: "an application test imports its feature's files by relative path: the handler from `./<feature>.handler.ts`, " +
            "the command from `./<feature>.command.ts`, types from `./<feature>.contract.ts`; domain values come from " +
            "`@<scope>/<context>/domain`.",
        },
      }],
    },
  ],
});
