import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { contractImportsContractsOnly } from "./contract-imports-contracts-only.ts";
import { EXAMPLE_CONCEPTS } from "../../scripts/testdata/example-domain.ts";

// ADR 2026-059: a contract imports only contracts and the shared Result, as
// types; an application contract may also import its context's generated
// domain barrel (lead decision Q3). It inverts the retired
// no-cross-contract-type-import.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const DOMAIN = "contexts/pm/src/domain/notes/note.contract.ts";
const FEATURE = "contexts/pm/src/application/notes/create-note/create-note.contract.ts";

/** The worked example's create-note feature contract (TN-26-012 §3). */
const CREATE_NOTE = `import type { Note, NoteText, ProjectId, Result } from "@example/project-management/domain";

export interface CreateNoteInput {
  readonly projectId: string;
  readonly text: string;
}
`;

ruleTester.run("contract-imports-contracts-only", contractImportsContractsOnly, {
  valid: [
    ...EXAMPLE_CONCEPTS.map((c) => ({ code: c.contract, filename: c.contractPath })),
    { code: CREATE_NOTE, filename: FEATURE },
    // sibling, other area, deeper relative, and the shared result
    { code: 'import type { NoteId } from "./note-id.contract.ts";', filename: DOMAIN },
    { code: 'import type { ProjectId } from "../projects/project-id.contract.ts";', filename: DOMAIN },
    { code: 'import type { Result } from "../shared/result.ts";', filename: DOMAIN },
    { code: 'import type { Result } from "../../../domain/shared/result.ts";', filename: FEATURE },
    { code: 'import type { CreateNote } from "../create-note/create-note.contract.ts";', filename: FEATURE },
    // no imports at all
    { code: "export interface Clock { now(): Instant; }", filename: DOMAIN },
    // a file outside any domain directory may use the barrel
    { code: 'import type { Note } from "@acme/billing/domain";', filename: "file.ts" },
  ],
  invalid: [
    // an implementation file: the retired rule's recommended form
    {
      code: 'import type { ProjectId } from "../projects/project-id.ts";',
      filename: DOMAIN,
      errors: [{ messageId: "notAContract", data: { source: "../projects/project-id.ts" } }],
    },
    // the retired NodeNext spellings
    {
      code: 'import type { NoteId } from "./note-id.contract.js";',
      filename: DOMAIN,
      errors: [{ messageId: "jsSpecifier", data: { source: "./note-id.contract.js", fixed: "./note-id.contract.ts" } }],
    },
    { code: 'import type { NoteId } from "./note-id.js";', filename: DOMAIN, errors: [{ messageId: "jsSpecifier" }] },
    // near misses on the contract suffix
    { code: 'import type { NoteId } from "./note-id.contract";', filename: DOMAIN, errors: [{ messageId: "notAContract" }] },
    { code: 'import type { NoteId } from "./note-id.contracts.ts";', filename: DOMAIN, errors: [{ messageId: "notAContract" }] },
    { code: 'import type { NoteId } from "note-id.contract.ts";', filename: DOMAIN, errors: [{ messageId: "notAContract" }] },
    // result must be the shared one
    { code: 'import type { Result } from "../result.ts";', filename: DOMAIN, errors: [{ messageId: "notAContract" }] },
    { code: 'import type { Result } from "../shared/results.ts";', filename: DOMAIN, errors: [{ messageId: "notAContract" }] },
    // packages: zod, a sibling package's application barrel, a deep import
    { code: 'import type { z } from "zod";', filename: DOMAIN, errors: [{ messageId: "notAContract" }] },
    { code: 'import type { CreateNote } from "@example/project-management/application";', filename: FEATURE, errors: [{ messageId: "notAContract" }] },
    { code: 'import type { Note } from "@example/project-management/domain/notes";', filename: FEATURE, errors: [{ messageId: "notAContract" }] },
    { code: 'import type { Note } from "@example/domain";', filename: FEATURE, errors: [{ messageId: "notAContract" }] },
    // the barrel from inside the domain
    {
      code: 'import type { ProjectId } from "@example/project-management/domain";',
      filename: DOMAIN,
      errors: [{ messageId: "barrelInDomain" }],
    },
    // value and inline-type imports
    { code: 'import { NoteId } from "./note-id.contract.ts";', filename: DOMAIN, errors: [{ messageId: "valueImport" }] },
    { code: 'import { type NoteId } from "./note-id.contract.ts";', filename: DOMAIN, errors: [{ messageId: "inlineType" }] },
    { code: 'import { type NoteId, NoteText } from "./note-id.contract.ts";', filename: DOMAIN, errors: [{ messageId: "valueImport" }] },
    // namespace, default, renamed
    { code: 'import type * as Ids from "./note-id.contract.ts";', filename: DOMAIN, errors: [{ messageId: "shape" }] },
    { code: 'import type NoteId from "./note-id.contract.ts";', filename: DOMAIN, errors: [{ messageId: "shape" }] },
    { code: 'import type { NoteId as Id } from "./note-id.contract.ts";', filename: DOMAIN, errors: [{ messageId: "shape" }] },
    // side effects
    { code: 'import "./note-id.contract.ts";', filename: DOMAIN, errors: [{ messageId: "sideEffect" }] },
    // re-exports of any kind
    { code: 'export type { NoteId } from "./note-id.contract.ts";', filename: DOMAIN, errors: [{ messageId: "reexport" }] },
    { code: 'export type * from "./note-id.contract.ts";', filename: DOMAIN, errors: [{ messageId: "reexport" }] },
    { code: 'export * from "../shared/result.ts";', filename: DOMAIN, errors: [{ messageId: "reexport" }] },
  ],
});
