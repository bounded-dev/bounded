import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { compositionRootOnlyConstructs, entryHostsOnly } from "./composition-rules.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const options = [{
  workspaces: { "@example/project-management": "contexts/project-management", "@example/web": "apps/web" },
}] as const;
const C = "contexts/project-management/src";
const ROOT = "apps/web/src/server/composition-root.ts";
const MAIN = "apps/web/src/server/main.ts";
const APP = `import { CreateNoteHandler } from "@example/project-management/application";\n`;
const MEMORY = `import { InMemoryCreateNoteStore, InMemoryDatabase } from "@example/project-management/adapters/in-memory";\n`;
const ROUTER = `import { createProjectManagementRouter } from "@example/project-management/adapters/trpc";\n`;
const at = (filename: string, code: string) => ({ code, filename, options });
const bad = <Id extends "construct" | "factory" | "value">(filename: string, code: string, ...ids: Id[]) =>
  ({ code, filename, options, errors: ids.map((messageId) => ({ messageId })) });

ruleTester.run("composition-root-only-constructs", compositionRootOnlyConstructs, {
  valid: [
    at(ROOT, `${APP}${MEMORY}${ROUTER}const db = new InMemoryDatabase();\nexport const app = createProjectManagementRouter({ createNote: new CreateNoteHandler(new InMemoryCreateNoteStore(db)) });`),
    at("apps/lambdas/src/composition-root.ts", `${APP}export const h = new CreateNoteHandler(null!);`),
    // Tests construct handlers and stores with fakes.
    at(`${C}/application/notes/create-note/create-note.test.ts`, `import { CreateNoteHandler } from "./create-note.handler.ts";\nnew CreateNoteHandler(fake);`),
    at(`${C}/adapters/out/in-memory/notes/create-note.store.test.ts`, `import { InMemoryDatabase } from "../in-memory-database.ts";\nnew InMemoryDatabase();`),
    at("apps/web/src/server/composition-root.test.ts", `${MEMORY}new InMemoryDatabase();`),
    // Domain objects are built everywhere they are needed.
    at(`${C}/application/notes/create-note/create-note.handler.ts`, `import { Note, NoteId } from "@example/project-management/domain";\nnew Note(NoteId.generate());`),
    // An adapter builds its own parts.
    at(`${C}/adapters/in/trpc/router.ts`, `import { createNotesRouter } from "./notes/notes.router.ts";\ncreateNotesRouter(deps);`),
    at(`${C}/adapters/out/drizzle/notes/create-note.store.ts`, `import { NoteMapper } from "./note.mapper.ts";\nnew NoteMapper();`),
    // Types are not construction; library classes are not wiring.
    at(MAIN, `import type { ProjectManagementRouter } from "@example/project-management/adapters/trpc";\nlet r: ProjectManagementRouter;`),
    at(MAIN, `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";\nnew StdioServerTransport();`),
    at(MAIN, `import { composeApp } from "./composition-root.ts";\nconst app = composeApp();`),
  ],
  invalid: [
    bad(MAIN, `${APP}new CreateNoteHandler(store);`, "construct"),
    bad(MAIN, `${MEMORY}new InMemoryDatabase();`, "construct"),
    bad(MAIN, `${ROUTER}createProjectManagementRouter(deps);`, "factory"),
    bad("apps/web/src/server/seed.ts", `import { CreateNoteHandler as H } from "@example/project-management/application";\nnew H(store);`, "construct"),
    bad(`${C}/application/notes/create-note/create-note.handler.ts`, `import { ListNotesHandler } from "../list-notes/list-notes.handler.ts";\nnew ListNotesHandler(store);`, "construct"),
    bad(`${C}/application/notes/create-note/create-note.handler.ts`, `import { InMemoryDatabase } from "../../../adapters/out/in-memory/in-memory-database.ts";\nnew InMemoryDatabase();`, "construct"),
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `${APP}new CreateNoteHandler(store);`, "construct"),
    bad(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, `${MEMORY}new InMemoryDatabase();`, "construct"),
    // A file named like the root, in the wrong place, is not the root.
    bad("apps/web/src/server/composition-root-helpers.ts", `${APP}new CreateNoteHandler(store);`, "construct"),
  ],
});

ruleTester.run("entry-hosts-only", entryHostsOnly, {
  valid: [
    at(MAIN, `import { composeApp } from "./composition-root.ts";\nimport index from "../client/index.html";`),
    at(MAIN, `import { fetchRequestHandler } from "@trpc/server/adapters/fetch";`),
    at("apps/web/src/server/seed.ts", `import type { ProjectManagementRouter } from "@example/project-management/adapters/trpc";`),
    at("apps/lambdas/src/export-projects.ts", `import { composeExportProjects } from "./composition-root.ts";\nexport const handler = composeExportProjects();`),
    at(ROOT, `${APP}${MEMORY}`),
    at("apps/web/src/server/composition-root.test.ts", `import { NoteText } from "@example/project-management/domain";`),
    // Browser code has its own rule.
    at("apps/web/src/client/main.tsx", `import { NoteText } from "@example/project-management/domain";`),
    // Contexts are not apps.
    at(`${C}/adapters/in/trpc/router.ts`, `import { t } from "./trpc.ts";`),
  ],
  invalid: [
    bad(MAIN, APP, "value"),
    bad(MAIN, `import { type ProjectManagementRouter } from "@example/project-management/adapters/trpc";`, "value"),
    bad(MAIN, `import { NoteText } from "@example/project-management/domain";`, "value"),
    bad(MAIN, `const m = await import("@example/project-management/adapters/trpc");`, "value"),
    bad("apps/mcp/src/main.ts", `export { createProjectManagementMcpServer } from "@example/project-management/adapters/mcp";`, "value"),
    bad("apps/web/src/server/composition-root-helpers.ts", APP, "value"),
  ],
});
