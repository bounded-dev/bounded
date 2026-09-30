import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { fileRoleSuffix } from "./file-role-suffix.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const C = "contexts/project-management/src";
const ok = (filename: string) => ({ code: "export {};", filename });
const bad = (filename: string) => ({ code: "export {};", filename, errors: [{ messageId: "role" as const }] });

ruleTester.run("file-role-suffix", fileRoleSuffix, {
  valid: [
    // Every row of the layout.
    ...[
      "domain/index.ts", "domain/shared/result.ts", "domain/shared/errors.ts",
      "domain/notes/note.contract.ts", "domain/notes/note.ts", "domain/notes/note.test.ts", "domain/notes/note.laws.test.ts",
      "domain/order-lines/order-line-id.ts",
      "application/index.ts",
      "application/notes/create-note/create-note.contract.ts", "application/notes/create-note/create-note.command.ts",
      "application/notes/create-note/create-note.handler.ts", "application/notes/create-note/create-note.test.ts",
      "application/notes/create-note/create-note.command.laws.test.ts",
      "application/notes/create-note/create-note.store.test-support.ts",
      "adapters/in/trpc/index.ts", "adapters/in/trpc/trpc.ts", "adapters/in/trpc/router.ts",
      "adapters/in/trpc/notes/notes.router.ts", "adapters/in/trpc/notes/create-note.procedure.ts",
      "adapters/in/trpc/notes/create-note.procedure.laws.test.ts", "adapters/in/mcp/server.ts",
      "adapters/out/in-memory/index.ts", "adapters/out/in-memory/in-memory-database.ts",
      "adapters/out/in-memory/notes/create-note.store.ts", "adapters/out/in-memory/notes/create-note.store.test.ts",
      "adapters/out/console/projects/export-projects.exporter.ts", "adapters/out/drizzle/notes/note.mapper.ts",
      "adapters/out/drizzle/schema/project-management.schema.ts", "adapters/out/drizzle/schema/notes.ts",
      "adapters/out/drizzle/drizzle-database.ts", "adapters/out/drizzle/drizzle-test-database.test-support.ts",
      "adapters/out/drizzle/migrations/0000_init.ts",
    ].map((p) => ok(`${C}/${p}`)),
    // Apps are free-form below src/, as long as names are kebab-case.
    ok("apps/web/src/client/main.tsx"), ok("apps/web/src/server/composition-root.ts"),
    ok("apps/web/src/server/composition-root.test.ts"), ok("apps/lambdas/src/export-projects.ts"),
    // Outside every source root: not this rule's business.
    ok("scripts/whatever_Name.ts"), ok("architecture.test.ts"),
  ],
  invalid: [
    bad(`${C}/utils.ts`),
    bad(`${C}/shared/result.ts`),
    bad(`${C}/adapters/trpc/router.ts`),
    bad(`${C}/domain/note.ts`),
    bad(`${C}/domain/notes/deep/note.ts`),
    bad(`${C}/domain/notes/note.handler.ts`),
    bad(`${C}/domain/notes/NoteText.ts`),
    bad(`${C}/domain/Notes/note.ts`),
    bad(`${C}/domain/notes/note_text.ts`),
    bad(`${C}/domain/notes/note.tsx`),
    bad(`${C}/application/notes/create-note.handler.ts`),
    bad(`${C}/application/notes/create-note/note.handler.ts`),
    bad(`${C}/application/notes/create-note/create-note.store.ts`),
    bad(`${C}/application/notes/create-note/create-note.helpers.ts`),
    bad(`${C}/application/notes/create-note/create-notes.handler.ts`),
    bad(`${C}/application/notes/create-note/sub/create-note.handler.ts`),
    bad(`${C}/application/shared/clock.contract.ts`),
    bad(`${C}/adapters/in/trpc/notes/deep/create-note.procedure.ts`),
    bad(`${C}/adapters/in/trpc/notes/create-note.ts`),
    bad(`${C}/adapters/out/in-memory/database.ts`),
    bad(`${C}/adapters/out/in-memory/notes/create-note.ts`),
    bad(`${C}/adapters/out/in-memory/notes/sub/create-note.store.ts`),
    bad(`${C}/adapters/out/in-memory/notes/create-note.store.extra.ts`),
    bad("apps/web/src/Client/main.tsx"),
    bad("apps/web/src/server/compositionRoot.ts"),
  ],
});
