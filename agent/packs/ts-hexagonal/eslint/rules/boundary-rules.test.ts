import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { clientTypeOnlyServerImports, inAdapterUsesInPort, layerDependency, noCrossContextImport } from "./boundary-rules.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

/** The fixture's workspaces, as the rules would read them from the manifests. */
const options = [{
  workspaces: {
    "@example/project-management": "contexts/project-management",
    "@example/billing": "contexts/billing",
    "@example/web": "apps/web",
    "@example/mcp": "apps/mcp",
  },
}] as const;

const C = "contexts/project-management/src";
const at = (filename: string, code: string) => ({ code, filename, options });
const bad = (filename: string, code: string, errors = 1) => ({
  code, filename, options, errors: Array.from({ length: errors }, () => ({ messageId: "problem" as const })),
});

ruleTester.run("layer-dependency", layerDependency, {
  valid: [
    // --- every legal direction inside a context ---------------------------
    at(`${C}/domain/notes/note.ts`, `import type * as Contract from "./note.contract.ts";`),
    at(`${C}/domain/notes/note.contract.ts`, `import type { ProjectId } from "../projects/project-id.contract.ts";`),
    at(`${C}/domain/notes/note-text.ts`, `import { z } from "zod";`),
    at(`${C}/domain/notes/note-text.ts`, `import { z } from "zod/v4";`),
    at(`${C}/application/notes/create-note/create-note.contract.ts`, `import type { Note } from "@example/project-management/domain";`),
    at(`${C}/application/notes/create-note/create-note.handler.ts`, `import { NotImplementedError } from "../../../domain/shared/errors.ts";`),
    at(`${C}/application/notes/create-note/create-note.command.ts`, `import type * as Contract from "./create-note.contract.ts";`),
    at(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `import { CreateNoteCommand } from "@example/project-management/application";`),
    at(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `import { t } from "../trpc.ts";`),
    at(`${C}/adapters/in/trpc/trpc.ts`, `import { initTRPC } from "@trpc/server";`),
    at(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, `import type { InMemoryDatabase } from "../in-memory-database.ts";`),
    at(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, `import type { Note } from "@example/project-management/domain";`),
    at(`${C}/adapters/out/drizzle/notes/create-note.store.ts`, `import { eq } from "drizzle-orm";`),
    // Tests may use a test runner in any layer, and store tests reach the conformance suite.
    at(`${C}/domain/notes/note.test.ts`, `import { expect, test } from "bun:test";`),
    at(`${C}/adapters/out/in-memory/notes/create-note.store.test.ts`,
      `import { suite } from "../../../../application/notes/create-note/create-note.store.test-support.ts";`),
    // --- apps -----------------------------------------------------------------
    at("apps/web/src/server/composition-root.ts", `import { CreateNoteHandler } from "@example/project-management/application";`),
    at("apps/web/src/server/composition-root.ts", `import { InMemoryDatabase } from "@example/project-management/adapters/in-memory";`),
    at("apps/web/src/server/main.ts", `import index from "../client/index.html";`),
    at("apps/web/src/server/main.ts", `import { fetchRequestHandler } from "@trpc/server/adapters/fetch";`),
    at("apps/mcp/src/main.ts", `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";`),
    // A scoped package that merely looks like a workspace is a library.
    at(`${C}/adapters/in/mcp/server.ts`, `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`),
    // Not under a source root at all.
    at("scripts/tool.ts", `import x from "../contexts/project-management/src/adapters/in/trpc/index.ts";`),
  ],
  invalid: [
    bad(`${C}/domain/notes/note.ts`, `import type { CreateNote } from "../../application/notes/create-note/create-note.contract.ts";`),
    bad(`${C}/domain/notes/note.ts`, `import type { X } from '../../adapters/out/in-memory/index.ts';`),
    bad(`${C}/domain/notes/note.ts`, `export { X } from "@example/project-management/application";`),
    bad(`${C}/domain/notes/note.ts`, `export * from "@example/project-management/adapters/trpc";`),
    bad(`${C}/domain/notes/note.ts`, `const m = await import("../../application/index.ts");`),
    bad(`${C}/domain/notes/note.ts`, "const m = await import(`../../application/index.ts`);"),
    bad(`${C}/domain/notes/note.ts`, `import "../../adapters/out/in-memory/index.ts";`),
    bad(`${C}/domain/notes/note.ts`, `import x = require("../../application/index.ts");`),
    bad(`${C}/domain/notes/note.ts`, `const x = require("../../application/index.ts");`),
    bad(`${C}/domain/notes/note.ts`, `type T = import("../../application/index.ts").CreateNote;`),
    bad(`${C}/domain/notes/note.ts`, `import type { Note } from "@example/project-management/domain";`),
    bad(`${C}/domain/notes/note.ts`, `import { randomUUID } from "node:crypto";`),
    bad(`${C}/domain/notes/note.ts`, `import { format } from "date-fns";`),
    bad(`${C}/domain/notes/note.ts`, `const m = await import(name);`),
    // Every loader, and files the TypeScript-only scan used to miss.
    bad(`${C}/domain/notes/note.ts`, `const m = import.meta.require("../../application/index.ts");`),
    bad(`${C}/domain/notes/note.ts`, `const m = import.meta.resolve("../../application/index.ts");`),
    bad(`${C}/domain/notes/note.ts`, `const m = require.resolve("../../adapters/out/in-memory/index.ts");`),
    bad(`${C}/domain/notes/note.ts`, `const m = module.require("../../application/index.ts");`),
    bad(`${C}/domain/notes/.hidden.ts`, `import { x } from "../../application/index.ts";`),
    bad(`${C}/domain/notes/legacy.js`, `import { x } from "../../application/index.ts";`),
    bad(`${C}/domain/notes/legacy.jsx`, `import { x } from "../../application/index.ts";`),
    bad(`${C}/domain/notes/legacy.mjs`, `export { x } from "../../adapters/out/console/index.ts";`),
    bad(`${C}/domain/notes/legacy.cjs`, `const x = require("../../application/index.ts");`),
    bad(`${C}/application/notes/create-note/create-note.handler.ts`, `import { InMemoryDatabase } from "@example/project-management/adapters/in-memory";`),
    bad(`${C}/application/notes/create-note/create-note.handler.ts`, `import type { X } from "../../../adapters/out/in-memory/index.ts";`),
    bad(`${C}/application/notes/create-note/create-note.handler.ts`, `import { CreateNote } from "@example/project-management/application";`),
    bad(`${C}/application/notes/create-note/create-note.handler.ts`, `import { Pool } from "pg";`),
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `import { InMemoryDatabase } from "../../../out/in-memory/index.ts";`),
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `import { server } from "../../mcp/server.ts";`),
    bad(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, `import { x } from "../../drizzle/drizzle-database.ts";`),
    bad(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, `import { DrizzleDatabase } from "@example/project-management/adapters/drizzle";`),
    bad(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, `import { x } from "@example/project-management/src/domain/index.ts";`),
    bad(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, `import { x } from "../../../../../package.json";`),
    bad(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, `import { x } from "/abs/path.ts";`),
    bad(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, `import { x } from "../../../../../../../../../../../outside.ts";`),
    // Apps.
    bad("apps/web/src/server/composition-root.ts", `import { x } from "@example/project-management";`),
    bad("apps/web/src/server/composition-root.ts", `import { x } from "@example/project-management/src/application/index.ts";`),
    bad("apps/web/src/server/composition-root.ts", `import { x } from "@example/mcp";`),
    bad("apps/web/src/server/composition-root.ts", `import { x } from "../../../mcp/src/main.ts";`),
    bad("apps/web/src/server/composition-root.ts", `import { x } from "../../../../contexts/project-management/src/application/index.ts";`),
  ],
});

ruleTester.run("no-cross-context-import", noCrossContextImport, {
  valid: [
    at(`${C}/application/notes/create-note/create-note.contract.ts`, `import type { Note } from "@example/project-management/domain";`),
    // The anti-corruption layer: an out adapter calling another context's application.
    at(`${C}/adapters/out/billing/projects/export-projects.exporter.ts`, `import type { CreateInvoice } from "@example/billing/application";`),
    at("apps/web/src/server/composition-root.ts", `import { CreateInvoiceHandler } from "@example/billing/application";`),
    // Relative paths that stay inside the context.
    at(`${C}/domain/notes/note.ts`, `import type { ProjectId } from "../projects/project-id.contract.ts";`),
  ],
  invalid: [
    bad(`${C}/domain/notes/note.ts`, `import type { InvoiceId } from "@example/billing/domain";`),
    bad(`${C}/application/notes/create-note/create-note.handler.ts`, `import type { CreateInvoice } from "@example/billing/application";`),
    // An in adapter is not the anti-corruption layer.
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `import type { CreateInvoice } from "@example/billing/application";`),
    // Only the application: never another context's domain or adapters, even from an out adapter.
    bad(`${C}/adapters/out/billing/projects/export-projects.exporter.ts`, `import { InvoiceId } from "@example/billing/domain";`),
    bad(`${C}/adapters/out/billing/projects/export-projects.exporter.ts`, `import { x } from "@example/billing/adapters/trpc";`),
    bad(`${C}/domain/notes/note.ts`, `import type { X } from "../../../../billing/src/domain/index.ts";`),
    bad(`${C}/domain/notes/note.ts`, `import type { X } from "@example/web";`),
    bad(`${C}/domain/notes/note.ts`, `import type { X } from "../../../../../apps/web/src/server/main.ts";`),
  ],
});

ruleTester.run("client-type-only-server-imports", clientTypeOnlyServerImports, {
  valid: [
    at("apps/web/src/client/main.tsx", `import type { ProjectManagementRouter } from "@example/project-management/adapters/trpc";`),
    at("apps/web/src/client/main.tsx", `export type { ProjectManagementRouter } from "@example/project-management/adapters/trpc";`),
    at("apps/web/src/client/main.tsx", `type R = import("@example/project-management/adapters/trpc").ProjectManagementRouter;`),
    at("apps/web/src/client/main.tsx", `import { createRoot } from "react-dom/client";`),
    at("apps/web/src/client/main.tsx", `import { App } from "./app.tsx";`),
    at("apps/web/src/client/pages/home.tsx", `import { Button } from "../ui/button.tsx";`),
    // Server code may import server code by value.
    at("apps/web/src/server/seed.ts", `import { composeApp } from "./composition-root.ts";`),
    // A folder merely named like the client, but not the client itself.
    at("apps/web/src/server/client/x.ts", `import { CreateNoteCommand } from "@example/project-management/application";`),
  ],
  invalid: [
    bad("apps/web/src/client/main.tsx", `import { ProjectManagementRouter } from "@example/project-management/adapters/trpc";`),
    bad("apps/web/src/client/main.tsx", `import { type ProjectManagementRouter } from "@example/project-management/adapters/trpc";`),
    bad("apps/web/src/client/main.tsx", `import "@example/project-management/domain";`),
    bad("apps/web/src/client/main.tsx", `export { NoteText } from "@example/project-management/domain";`),
    bad("apps/web/src/client/main.tsx", `const m = await import("@example/project-management/domain");`),
    bad("apps/web/src/client/main.tsx", `import { seed } from "../server/seed.ts";`),
    bad("apps/web/src/client/main.tsx", `import { type seed } from '../server/seed.ts';`),
    bad("apps/web/src/renderer/main.tsx", `import { NoteText } from "@example/project-management/domain";`),
  ],
});

ruleTester.run("in-adapter-uses-in-port", inAdapterUsesInPort, {
  valid: [
    at(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `import { CreateNoteCommand, type CreateNote } from "@example/project-management/application";`),
    at(`${C}/adapters/in/lambda/projects/export-projects.lambda.ts`, `import type { ExportProjects } from "@example/project-management/application";`),
    // A name that only contains the word is not a handler class.
    at(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `import { HandlerOptions } from "@trpc/server";`),
    // Composition roots are the one place handlers are named.
    at("apps/web/src/server/composition-root.ts", `import { CreateNoteHandler } from "@example/project-management/application";`),
    // Out adapters are not in adapters.
    at(`${C}/adapters/out/in-memory/notes/x.store.ts`, `import type { CreateNoteHandler } from "@example/project-management/application";`),
    // Whole-module forms of anything but application code are fine.
    at(`${C}/adapters/in/trpc/index.ts`, `export * from "./router.ts";`),
    at(`${C}/adapters/in/mcp/server.ts`, `import * as z from "zod";`),
    at(`${C}/adapters/in/trpc/index.ts`, `export * as Domain from "@example/project-management/domain";`),
  ],
  invalid: [
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `import { CreateNoteHandler } from "@example/project-management/application";`),
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `import type { CreateNoteHandler } from "@example/project-management/application";`),
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `import { CreateNoteHandler as H } from "@example/project-management/application";`),
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`,
      `import * as App from "@example/project-management/application";\nexport const p = new App.CreateNoteHandler();`, 2),
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`,
      `import type * as App from "@example/project-management/application";\nlet h: App.CreateNoteHandler;`, 2),
    // Fail closed where names cannot be followed: the module is never taken whole.
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`,
      `const { CreateNoteHandler: H } = await import("@example/project-management/application");`),
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`,
      `import * as App from "@example/project-management/application";\nexport const H = App["CreateNoteHandler"];`),
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`,
      `import * as App from "@example/project-management/application";\nconst A = App;\nexport const h = new A.CreateNoteHandler();`),
    bad(`${C}/adapters/in/trpc/index.ts`, `export * as App from "@example/project-management/application";`),
    bad(`${C}/adapters/in/trpc/index.ts`, `export * from "@example/project-management/application";`),
    bad(`${C}/adapters/in/trpc/index.ts`, `import App from "@example/project-management/application";`),
    bad(`${C}/adapters/in/trpc/index.ts`, `const App = require("@example/project-management/application");`),
    bad(`${C}/adapters/in/trpc/index.ts`, `export * as Notes from "../../../application/notes/create-note/create-note.contract.ts";`),
    bad(`${C}/adapters/in/trpc/notes/create-note.procedure.ts`, `type H = import("@example/project-management/application").CreateNoteHandler;`),
    bad(`${C}/adapters/in/mcp/server.ts`, `export { CreateProjectHandler } from "@example/project-management/application";`),
    bad(`${C}/adapters/in/lambda/projects/export-projects.lambda.ts`, `import { x } from "../../../../application/projects/export-projects/export-projects.handler.ts";`),
    bad(`${C}/adapters/in/lambda/projects/export-projects.lambda.ts`, `import { x } from "../../../../application/projects/export-projects/export-projects.handler";`),
  ],
});
