import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { naming } from "./naming.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const C = "contexts/project-management/src";
const ok = (filename: string, code = "export {};") => ({ code, filename });
const badPath = (filename: string) => ({ code: "export {};", filename, errors: [{ messageId: "path" as const }] });
const badClass = (filename: string, code: string) => ({ code, filename, errors: [{ messageId: "className" as const }] });

ruleTester.run("naming", naming, {
  valid: [
    ok(`${C}/domain/notes/note.ts`),
    ok(`${C}/domain/order-lines/order-line.ts`),
    ok(`${C}/domain/people/person.ts`),
    ok(`${C}/domain/categories/category.ts`),
    ok(`${C}/domain/shared/result.ts`),
    ok(`${C}/application/notes/create-note/create-note.contract.ts`),
    ok(`${C}/application/notes/list-notes/list-notes.handler.ts`, "export class ListNotesHandler implements ListNotes {}"),
    ok(`${C}/application/order-lines/add-order-line/add-order-line.handler.ts`, "export class AddOrderLineHandler {}"),
    ok(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, "export class InMemoryCreateNoteStore {}"),
    ok(`${C}/adapters/out/drizzle/notes/create-note.store.ts`, "export class DrizzleCreateNoteStore {}"),
    ok(`${C}/adapters/out/console/projects/export-projects.exporter.ts`, "export class ConsoleProjectExporter {}"),
    ok(`${C}/adapters/out/console/projects/export-projects.exporter.ts`, "export class ConsoleProjectCsvExporter {}"),
    ok(`${C}/adapters/out/in-memory/in-memory-database.ts`, "export class InMemoryDatabase {}"),
    ok(`${C}/adapters/out/drizzle/notes/note.mapper.ts`, "export class Anything {}"),
    ok(`${C}/adapters/in/trpc/notes/notes.router.ts`),
    ok(`${C}/adapters/out/drizzle/schema/notes.ts`),
    // Unexported helper classes are not the file's role class.
    ok(`${C}/application/notes/create-note/create-note.handler.ts`, "class Helper {}\nexport class CreateNoteHandler {}"),
    // Tests name their fakes freely.
    ok(`${C}/application/notes/create-note/create-note.test.ts`, "export class FakeStore {}"),
    ok("apps/web/src/server/main.ts", "export class Anything {}"),
  ],
  invalid: [
    badPath(`${C}/domain/note/note.ts`),
    badPath(`${C}/domain/address/address.ts`),
    badPath(`${C}/application/note/create-note/create-note.contract.ts`),
    badPath(`${C}/application/notes/create/create.contract.ts`),
    badPath(`${C}/application/notes/note-create/note-create.contract.ts`),
    badPath(`${C}/application/order-lines/order-lines-add/order-lines-add.contract.ts`),
    badPath(`${C}/adapters/out/in-memory/note/create-note.store.ts`),
    badPath(`${C}/adapters/out/in-memory/notes/create.store.ts`),
    badClass(`${C}/application/notes/create-note/create-note.handler.ts`, "export class CreateNotesHandler {}"),
    badClass(`${C}/application/notes/create-note/create-note.handler.ts`, "export class CreateNote {}"),
    badClass(`${C}/application/notes/create-note/create-note.handler.ts`, "export default class NoteHandler {}"),
    badClass(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, "export class CreateNoteStore {}"),
    badClass(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, "export class InmemoryCreateNoteStore {}"),
    badClass(`${C}/adapters/out/in-memory/notes/create-note.store.ts`, "export class InMemoryListNotesStore {}"),
    badClass(`${C}/adapters/out/console/projects/export-projects.exporter.ts`, "export class ProjectExporter {}"),
    badClass(`${C}/adapters/out/console/projects/export-projects.exporter.ts`, "export class ConsoleProjectExport {}"),
    badClass(`${C}/adapters/out/console/projects/export-projects.exporter.ts`, "export class ConsoleExporter {}"),
    badClass(`${C}/adapters/out/in-memory/in-memory-database.ts`, "export class MemoryDatabase {}"),
  ],
});
