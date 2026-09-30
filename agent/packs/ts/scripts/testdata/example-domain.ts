// The worked example's domain, copied inline (ADR 2026-059, TN-26-012). The
// fixtures for the contract lint rules, the domain parser and the domain
// emitter: every contract here must pass contract-purity, parse, and emit a
// skeleton whose tail is byte-identical to the implementation beside it.
// Copied, never read from disk: no committed test may depend on a path
// outside this repository. Keep in step with the example by hand.

export interface ExampleConcept {
  /** Project-relative, as in the example's context. */
  readonly contractPath: string;
  readonly contract: string;
  /** The example's delivered implementation file. */
  readonly implementation: string;
}

export const EXAMPLE_ROOT = "contexts/project-management/src/domain";

export const EXAMPLE_RESULT = `export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };
`;

export const EXAMPLE_CONCEPTS: readonly ExampleConcept[] = [
  {
    contractPath: `${EXAMPLE_ROOT}/notes/note-id.contract.ts`,
    contract: `import type { Result } from "../shared/result.ts";

export interface NoteId {
  readonly __brand: "NoteId";
  readonly value: string;
  equals(other: NoteId): boolean;
  toJSON(): string;
}

export interface NoteIdFactory {
  generate(): NoteId;
  parse(raw: unknown): Result<NoteId>;
}
`,
    implementation: `import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./note-id.contract.ts";

const schema = z.uuid("Invalid note id");

class NoteIdImpl implements Contract.NoteId {
  declare readonly __brand: "NoteId";
  private constructor(readonly value: string) {}

  static generate(): NoteId {
    return new NoteIdImpl(crypto.randomUUID());
  }

  static parse(raw: unknown): Result<NoteId> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new NoteIdImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid note id" };
  }

  equals(other: NoteId): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type NoteId = Contract.NoteId;
export const NoteId: Contract.NoteIdFactory = NoteIdImpl;
`,
  },
  {
    contractPath: `${EXAMPLE_ROOT}/notes/note-text.contract.ts`,
    contract: `import type { Result } from "../shared/result.ts";

export interface NoteText {
  readonly __brand: "NoteText";
  readonly value: string;
  equals(other: NoteText): boolean;
  toJSON(): string;
}

export interface NoteTextFactory {
  parse(raw: unknown): Result<NoteText>;
}
`,
    implementation: `import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./note-text.contract.ts";

const schema = z.string().trim().min(1, "Note text is required");

class NoteTextImpl implements Contract.NoteText {
  declare readonly __brand: "NoteText";
  private constructor(readonly value: string) {}

  static parse(raw: unknown): Result<NoteText> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new NoteTextImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid note text" };
  }

  equals(other: NoteText): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type NoteText = Contract.NoteText;
export const NoteText: Contract.NoteTextFactory = NoteTextImpl;
`,
  },
  {
    contractPath: `${EXAMPLE_ROOT}/notes/note.contract.ts`,
    contract: `import type { ProjectId } from "../projects/project-id.contract.ts";
import type { NoteId } from "./note-id.contract.ts";
import type { NoteText } from "./note-text.contract.ts";

export interface Note {
  readonly __brand: "Note";
  readonly id: NoteId;
  readonly projectId: ProjectId;
  readonly text: NoteText;
  equals(other: Note): boolean;
  toJSON(): { readonly id: string; readonly projectId: string; readonly text: string };
}

export interface NoteFactory {
  new (id: NoteId, projectId: ProjectId, text: NoteText): Note;
}
`,
    implementation: `import type { ProjectId } from "../projects/project-id.contract.ts";
import type * as Contract from "./note.contract.ts";
import type { NoteId } from "./note-id.contract.ts";
import type { NoteText } from "./note-text.contract.ts";

// Entity: built from already-valid value objects, equal by identity.
class NoteImpl implements Contract.Note {
  declare readonly __brand: "Note";
  constructor(
    readonly id: NoteId,
    readonly projectId: ProjectId,
    readonly text: NoteText,
  ) {}

  equals(other: Note): boolean {
    return this.id.equals(other.id);
  }

  toJSON(): { readonly id: string; readonly projectId: string; readonly text: string } {
    return { id: this.id.value, projectId: this.projectId.value, text: this.text.value };
  }
}

export type Note = Contract.Note;
export const Note: Contract.NoteFactory = NoteImpl;
`,
  },
  {
    contractPath: `${EXAMPLE_ROOT}/projects/project-id.contract.ts`,
    contract: `import type { Result } from "../shared/result.ts";

export interface ProjectId {
  readonly __brand: "ProjectId";
  readonly value: string;
  equals(other: ProjectId): boolean;
  toJSON(): string;
}

export interface ProjectIdFactory {
  generate(): ProjectId;
  parse(raw: unknown): Result<ProjectId>;
}
`,
    implementation: `import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./project-id.contract.ts";

const schema = z.uuid("Invalid project id");

class ProjectIdImpl implements Contract.ProjectId {
  declare readonly __brand: "ProjectId";
  private constructor(readonly value: string) {}

  static generate(): ProjectId {
    return new ProjectIdImpl(crypto.randomUUID());
  }

  static parse(raw: unknown): Result<ProjectId> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new ProjectIdImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid project id" };
  }

  equals(other: ProjectId): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type ProjectId = Contract.ProjectId;
export const ProjectId: Contract.ProjectIdFactory = ProjectIdImpl;
`,
  },
  {
    contractPath: `${EXAMPLE_ROOT}/projects/project-name.contract.ts`,
    contract: `import type { Result } from "../shared/result.ts";

export interface ProjectName {
  readonly __brand: "ProjectName";
  readonly value: string;
  equals(other: ProjectName): boolean;
  toJSON(): string;
}

export interface ProjectNameFactory {
  parse(raw: unknown): Result<ProjectName>;
}
`,
    implementation: `import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./project-name.contract.ts";

const schema = z.string().trim().min(1, "Project name is required");

class ProjectNameImpl implements Contract.ProjectName {
  declare readonly __brand: "ProjectName";
  private constructor(readonly value: string) {}

  static parse(raw: unknown): Result<ProjectName> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new ProjectNameImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid project name" };
  }

  equals(other: ProjectName): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type ProjectName = Contract.ProjectName;
export const ProjectName: Contract.ProjectNameFactory = ProjectNameImpl;
`,
  },
  {
    contractPath: `${EXAMPLE_ROOT}/projects/project.contract.ts`,
    contract: `import type { ProjectId } from "./project-id.contract.ts";
import type { ProjectName } from "./project-name.contract.ts";

export interface Project {
  readonly __brand: "Project";
  readonly id: ProjectId;
  readonly name: ProjectName;
  equals(other: Project): boolean;
  toJSON(): { readonly id: string; readonly name: string };
}

export interface ProjectFactory {
  new (id: ProjectId, name: ProjectName): Project;
}
`,
    implementation: `import type * as Contract from "./project.contract.ts";
import type { ProjectId } from "./project-id.contract.ts";
import type { ProjectName } from "./project-name.contract.ts";

// Entity: built from already-valid value objects, equal by identity.
class ProjectImpl implements Contract.Project {
  declare readonly __brand: "Project";
  constructor(
    readonly id: ProjectId,
    readonly name: ProjectName,
  ) {}

  equals(other: Project): boolean {
    return this.id.equals(other.id);
  }

  toJSON(): { readonly id: string; readonly name: string } {
    return { id: this.id.value, name: this.name.value };
  }
}

export type Project = Contract.Project;
export const Project: Contract.ProjectFactory = ProjectImpl;
`,
  },
];

/** One example concept by its file stem, e.g. `note-id`. */
export function exampleConcept(stem: string): ExampleConcept {
  const found = EXAMPLE_CONCEPTS.find((c) => c.contractPath.endsWith(`/${stem}.contract.ts`));
  if (found === undefined) throw new Error(`no example concept ${stem}`);
  return found;
}
