import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { implTail } from "./impl-tail.ts";
import { EXAMPLE_CONCEPTS, exampleConcept } from "../../scripts/testdata/example-domain.ts";
import { implementationSkeleton } from "../../scripts/domain-emitter.ts";
import { parseDomainConcept } from "../../scripts/domain-concept.ts";

// ADR 2026-059: an implementation file hides `<Name>Impl`, implements the
// contract namespace, and ends with exactly the two generated exports. Every
// example implementation and every emitted skeleton passes; each near miss
// fails with the exact tail to write.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const FILE = "contexts/pm/src/domain/notes/note-text.ts";
const IMPORT = 'import type * as Contract from "./note-text.contract.ts";';
const CLASS = `class NoteTextImpl implements Contract.NoteText {
  declare readonly __brand: "NoteText";
  private constructor(readonly value: string) {}
}`;
const TAIL = `export type NoteText = Contract.NoteText;
export const NoteText: Contract.NoteTextFactory = NoteTextImpl;`;

function impl(parts: { imports?: string; cls?: string; tail?: string; extra?: string } = {}): string {
  return [parts.imports ?? IMPORT, "", parts.cls ?? CLASS, "", parts.extra ?? "", parts.tail ?? TAIL].join("\n") + "\n";
}

/** The worked example's generated command file (the tail beside a schema export). */
const COMMAND = `import { z } from "zod";
import { NoteText, ProjectId, type Result } from "@example/project-management/domain";
import type * as Contract from "./create-note.contract.ts";

export const createNoteSchema = z.object({
  projectId: z.string(),
  text: z.string(),
}) satisfies z.ZodType<Contract.CreateNoteInput>;

class CreateNoteCommandImpl implements Contract.CreateNoteCommand {
  declare readonly __brand: "CreateNoteCommand";
  private constructor(
    readonly projectId: ProjectId,
    readonly text: NoteText,
  ) {}

  static parse(raw: unknown): Result<CreateNoteCommand> {
    return { ok: false, error: "Invalid create note input" };
  }
}

export type CreateNoteCommand = Contract.CreateNoteCommand;
export const CreateNoteCommand: Contract.CreateNoteCommandFactory = CreateNoteCommandImpl;
`;
const COMMAND_FILE = "contexts/pm/src/application/notes/create-note/create-note.command.ts";

ruleTester.run("impl-tail", implTail, {
  valid: [
    // every implementation in the worked example
    ...EXAMPLE_CONCEPTS.map((c) => ({ code: c.implementation, filename: c.contractPath.replace(".contract.ts", ".ts") })),
    // every skeleton the emitter writes for it
    ...EXAMPLE_CONCEPTS.map((c) => ({
      code: implementationSkeleton(parseDomainConcept(c.contractPath, c.contract)),
      filename: c.contractPath.replace(".contract.ts", ".ts"),
    })),
    { code: impl(), filename: FILE },
    // a generated command file may export its schema beside the tail
    { code: COMMAND, filename: COMMAND_FILE },
    // not an implementation: no Impl class, no Contract namespace, no own contract import
    { code: "export class CreateNoteHandler implements CreateNote {}", filename: "contexts/pm/src/application/notes/create-note/create-note.handler.ts" },
    { code: 'import type { NoteText } from "./note-text.contract.ts";\nexport const x = 1;', filename: "contexts/pm/src/domain/notes/helpers.ts" },
    { code: "export const answer = 42;", filename: FILE },
  ],
  invalid: [
    // --- the tail ---------------------------------------------------------------
    { code: impl({ tail: "" }), filename: FILE, errors: [{ messageId: "tail" }] },
    // the two lines swapped
    {
      code: impl({ tail: "export const NoteText: Contract.NoteTextFactory = NoteTextImpl;\nexport type NoteText = Contract.NoteText;" }),
      filename: FILE,
      errors: [{ messageId: "tail" }],
    },
    // the factory annotation dropped: the static side is no longer checked
    {
      code: impl({ tail: "export type NoteText = Contract.NoteText;\nexport const NoteText = NoteTextImpl;" }),
      filename: FILE,
      errors: [{ messageId: "tail" }],
    },
    // annotated with the instance type instead of the factory
    {
      code: impl({ tail: "export type NoteText = Contract.NoteText;\nexport const NoteText: Contract.NoteText = NoteTextImpl;" }),
      filename: FILE,
      errors: [{ messageId: "tail" }],
    },
    // byte-level drift: spacing, a missing semicolon, let for const
    {
      code: impl({ tail: "export type NoteText = Contract.NoteText;\nexport const NoteText : Contract.NoteTextFactory = NoteTextImpl;" }),
      filename: FILE,
      errors: [{ messageId: "tail" }],
    },
    {
      code: impl({ tail: "export type NoteText = Contract.NoteText\nexport const NoteText: Contract.NoteTextFactory = NoteTextImpl;" }),
      filename: FILE,
      errors: [{ messageId: "tail" }],
    },
    {
      code: impl({ tail: "export type NoteText = Contract.NoteText;\nexport let NoteText: Contract.NoteTextFactory = NoteTextImpl;" }),
      filename: FILE,
      errors: [{ messageId: "tail" }],
    },
    // something after the tail
    {
      code: `${impl()}const later = 1;\n`,
      filename: FILE,
      errors: [{ messageId: "tail" }],
    },
    // --- the class ---------------------------------------------------------------
    { code: impl({ cls: `export ${CLASS}` }), filename: FILE, errors: [{ messageId: "implExported" }] },
    { code: impl({ extra: "export { NoteTextImpl };" }), filename: FILE, errors: [{ messageId: "implExported" }] },
    { code: impl({ cls: CLASS.replace(" implements Contract.NoteText", "") }), filename: FILE, errors: [{ messageId: "implements" }] },
    {
      code: impl({ cls: CLASS.replace("implements Contract.NoteText", "implements NoteText") }),
      filename: FILE,
      errors: [{ messageId: "implements" }],
    },
    {
      code: impl({ cls: CLASS.replace("implements Contract.NoteText", "extends Base implements Contract.NoteText") }),
      filename: FILE,
      errors: [{ messageId: "implements" }],
    },
    {
      code: impl({ cls: CLASS.replace("implements Contract.NoteText", "implements Contract.NoteText, Printable") }),
      filename: FILE,
      errors: [{ messageId: "implements" }],
    },
    // two Impl classes
    {
      code: impl({ extra: "class OtherImpl implements Contract.NoteText {}" }),
      filename: FILE,
      errors: [{ messageId: "implCount" }],
    },
    // --- the contract import --------------------------------------------------------
    { code: impl({ imports: "" }), filename: FILE, errors: [{ messageId: "contractImport" }] },
    {
      code: impl({ imports: 'import * as Contract from "./note-text.contract.ts";' }),
      filename: FILE,
      errors: [{ messageId: "contractImport" }],
    },
    {
      code: impl({ imports: 'import type * as Contract from "./note-id.contract.ts";' }),
      filename: FILE,
      errors: [{ messageId: "contractImport" }],
    },
    {
      code: impl({ imports: 'import type * as Contract from "./note-text.contract.js";' }),
      filename: FILE,
      errors: [{ messageId: "contractImport" }],
    },
    // named imports of the contract's types instead of the namespace: the trigger
    // is the Impl class, and the namespace import is missing
    {
      code: impl({ imports: 'import type { NoteText as C } from "./note-text.contract.ts";' }),
      filename: FILE,
      errors: [{ messageId: "contractImport" }],
    },
    // --- extra exports -------------------------------------------------------------
    // an own-contract implementation exports nothing but the tail
    { code: impl({ extra: "export const schema = 1;" }), filename: FILE, errors: [{ messageId: "extraExport" }] },
    { code: impl({ extra: "export default NoteTextImpl;" }), filename: FILE, errors: [{ messageId: "extraExport" }] },
    { code: impl({ extra: 'export * from "./other.ts";' }), filename: FILE, errors: [{ messageId: "extraExport" }] },
    // a command file may export helpers, but never a second binding of the name
    {
      code: COMMAND.replace("export const createNoteSchema", "export const CreateNoteCommand2 = 1;\nexport { CreateNoteCommandImpl as CreateNoteCommand3 };\nexport const createNoteSchema"),
      filename: COMMAND_FILE,
      errors: [{ messageId: "implExported" }],
    },
    // the trigger without a class: a file that imports its own contract
    {
      code: 'import type { NoteText } from "./note-text.contract.ts";\nexport function make(): NoteText { throw new Error(); }\n',
      filename: FILE,
      errors: [{ messageId: "implCount" }],
    },
    // an example implementation with its tail edited is caught
    {
      code: exampleConcept("note").implementation.replace("export const Note: Contract.NoteFactory = NoteImpl;", "export const Note = NoteImpl;"),
      filename: "contexts/pm/src/domain/notes/note.ts",
      errors: [{ messageId: "tail" }],
    },
  ],
});
