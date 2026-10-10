import { describe, expect, test } from "bun:test";
import type { PackSourceApi } from "./build-package-catalog.contract.ts";

/** A copy of the demonstration package (demo-package, sources only, with `files` written over it and `remove` taken out) and the PackSourceApi under test. */
export interface PackSourceApiFixture {
  readonly sourceApi: PackSourceApi;
  readonly packageDir: string;
}

export interface PackSourceApiChanges {
  readonly files?: Readonly<Record<string, string>>;
  readonly remove?: readonly string[];
}

const EXAMPLE = "packs/demo/examples/basic.config.ts";
const request = (packageDir: string) => ({ packageDir, packDir: "packs/demo", exportName: "demoPack", examplePaths: [EXAMPLE] });

/** NoteJSON as a type the schema generator cannot describe, though TypeScript can. */
const UNDESCRIBABLE_NOTE = `import type { Result } from "bounded/domain";

/** A note's wire form, in capitals. */
export interface NoteJSON {
  readonly text: Uppercase<string>;
}

/** A note. */
export interface Note {
  readonly __brand: "Note";
  readonly text: string;
  equals(other: Note): boolean;
  toJSON(): NoteJSON;
}

export interface NoteFactory {
  parse(raw: unknown): Result<Note>;
}
`;

/** The demonstration pack's contract, with `points` written over its points' declarations and `imports` added after its own. */
const demoContract = (points: string, imports = ""): string => `import type { BasePack, ExtensionPoint, PortKey } from "bounded/domain";
import type { NoteStore } from "./application/keep-notes.contract.ts";
import type { DemoId } from "./domain/demo-id.ts";
import type { Note } from "./domain/note.contract.ts";
${imports}
/** The demonstration pack's points. */
export type DemoPoints = {
${points}
};

/** The adapters the demonstration pack needs a host to provide. */
export type DemoPorts = {
  readonly noteStore: PortKey<NoteStore, DemoId>;
};

/** The demonstration pack: its id, its points and its ports. */
export interface DemoPack extends BasePack {
  readonly id: DemoId;
  readonly points: DemoPoints;
  readonly ports: DemoPorts;
}
`;
const NOTES_POINT = `  /** Notes: one line of text each, kept by the project for its agents. */
  readonly notes: ExtensionPoint<Note, DemoId>;`;

/** The behaviour every PackSourceApi must have. */
export function packSourceApiConformance(name: string, fixture: (changes?: PackSourceApiChanges) => Promise<PackSourceApiFixture>): void {
  describe(`${name} conforms to PackSourceApi`, () => {
    test("gives the overview's exported name and TSDoc", async () => {
      const given = await fixture();
      const read = await given.sourceApi.read(request(given.packageDir));
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.overview.name).toBe("demoPack");
      expect(read.value.overview.documentation).toStartWith("The demonstration pack, `demo-package/demo`: projects contribute notes to\n`notes`");
    });

    test("gives each point's key, value type, TSDoc, wire type and the wire type's schema", async () => {
      const given = await fixture();
      const read = await given.sourceApi.read(request(given.packageDir));
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.points.map(({ key, valueType, documentation }) => ({ key, valueType, documentation }))).toEqual([{ key: "notes", valueType: "Note", documentation: "Notes: one line of text each, kept by the project for its agents." }]);
      const [notes] = read.value.points;
      expect(notes?.wire?.type).toBe("NoteJSON");
      expect(notes?.wire?.schema).toMatchObject({ $ref: "#/definitions/NoteJSON", definitions: { NoteJSON: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } } });
    });

    test("gives each port's key, adapter interface, its TSDoc without tags and its declaration", async () => {
      const given = await fixture();
      const read = await given.sourceApi.read(request(given.packageDir));
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.ports.map(({ key, adapterType, documentation }) => ({ key, adapterType, documentation }))).toEqual([{ key: "noteStore", adapterType: "NoteStore", documentation: "Where notes are kept between tool calls." }]);
      expect(read.value.ports[0]?.declaration).toStartWith("interface NoteStore {");
      expect(read.value.ports[0]?.declaration).toContain("save(text: string): Promise<void>;");
      expect(JSON.stringify(read.value)).not.toContain("@implementedBy");
    });

    test("gives each example's TSDoc, from its default export", async () => {
      const given = await fixture();
      const read = await given.sourceApi.read(request(given.packageDir));
      expect(read.ok).toBe(true);
      expect(read.ok && read.value.examples).toEqual([{ path: EXAMPLE, documentation: "Keep a note\n\nThe project keeps one note for its agents: where plans live." }]);
    });

    test("refuses when no tsconfig.json is found, naming the file to add", async () => {
      const given = await fixture({ remove: ["tsconfig.json"] });
      const read = await given.sourceApi.read(request(given.packageDir));
      expect(read.ok).toBe(false);
      expect(!read.ok && read.error).toContain("tsconfig.json");
    });

    test("refuses a data point whose wire type the schema generator cannot describe, naming the point and the type", async () => {
      const given = await fixture({ files: { "packs/demo/domain/note.contract.ts": UNDESCRIBABLE_NOTE } });
      const read = await given.sourceApi.read(request(given.packageDir));
      expect(read.ok).toBe(false);
      expect(!read.ok && read.error).toContain("notes");
      expect(!read.ok && read.error).toContain("NoteJSON");
    });

    test("reads only the pack's files: an unrelated file the tsconfig includes, holding a type error, changes nothing", async () => {
      const plain = await fixture();
      const baseline = await plain.sourceApi.read(request(plain.packageDir));
      expect(baseline.ok).toBe(true);
      const tsconfig = JSON.stringify({ compilerOptions: { target: "ESNext", module: "Preserve", moduleResolution: "bundler", allowImportingTsExtensions: true, noEmit: true, strict: true, skipLibCheck: true }, include: ["unrelated.ts", "packs/**/*.ts"] });
      const given = await fixture({ files: { "tsconfig.json": tsconfig, "unrelated.ts": "export const count: number = 'not a number';\nexport interface NoteJSON { readonly other: number }\n" } });
      const read = await given.sourceApi.read(request(given.packageDir));
      expect(read.ok).toBe(true);
      expect(read).toEqual(baseline);
    });
    test("describes a point of plain data with no name directly: its type text, and a schema of the type itself", async () => {
      const points = `${NOTES_POINT}
  /** Labels: one word each. */
  readonly labels: ExtensionPoint<string, DemoId>;
  /** A level. */
  readonly levels: ExtensionPoint<"low" | "high", DemoId>;`;
      const given = await fixture({ files: { "packs/demo/demo.contract.ts": demoContract(points) } });
      const read = await given.sourceApi.read(request(given.packageDir));
      expect(read.ok ? "ok" : read.error).toBe("ok");
      if (!read.ok) return;
      expect(read.value.points.map(({ key }) => key)).toEqual(["notes", "labels", "levels"]);
      const labels = read.value.points.find(({ key }) => key === "labels");
      expect(labels?.valueType).toBe("string");
      expect(labels?.wire?.type).toBe("string");
      expect(labels?.wire?.schema).toMatchObject({ type: "string" });
      const levels = read.value.points.find(({ key }) => key === "levels");
      expect(levels?.wire?.type).toBe('"low" | "high"');
      expect(levels?.wire?.schema).toMatchObject({ type: "string", enum: ["low", "high"] });
    });

    test("generates a wire type's schema from the declaration the checker resolved, never by name: a same-named type elsewhere does not replace it", async () => {
      const shadow = `/** Another NoteJSON, unrelated to the point's. */
export interface NoteJSON {
  readonly shadowed: number;
}
`;
      const imports = `import type { NoteJSON as ShadowNoteJSON } from "./domain/shadow.contract.ts";
/** Uses the shadowing type, so it is in the program. */
export type Shadowing = ShadowNoteJSON;
`;
      const given = await fixture({ files: { "packs/demo/domain/shadow.contract.ts": shadow, "packs/demo/demo.contract.ts": demoContract(NOTES_POINT, imports) } });
      const read = await given.sourceApi.read(request(given.packageDir));
      expect(read.ok ? "ok" : read.error).toBe("ok");
      if (!read.ok) return;
      const schema = JSON.stringify(read.value.points[0]?.wire?.schema);
      expect(schema).toContain('"text"');
      expect(schema).not.toContain("shadowed");
    });

    test("names the overview's pack by the name the module exports it under, not the first exported const", async () => {
      const overview = `import { contribution, corePack, definePack } from "bounded/domain";
import { noteStorePort } from "./application/keep-notes.contract.ts";
import { allowEveryCall } from "./application/keep-notes.lifecycle.ts";
import { demoId } from "./domain/demo-id.ts";
import { notesPoint } from "./domain/note.ts";
import type { DemoPack } from "./demo.contract.ts";

/** A helper exported before the pack. */
export const helperValue = 1;

/**
 * The demonstration pack, \`demo-package/demo\`: projects contribute notes to
 * \`notes\`, and its check before each tool call allows it.
 */
export const demoPack: DemoPack = definePack({
  id: demoId,
  dependsOn: [corePack],
  points: { notes: notesPoint },
  contributes: [contribution(corePack.points.beforeTool, [allowEveryCall])],
  ports: { noteStore: noteStorePort },
});
`;
      const given = await fixture({ files: { "packs/demo/demo.pack.ts": overview } });
      const read = await given.sourceApi.read(request(given.packageDir));
      expect(read.ok ? "ok" : read.error).toBe("ok");
      if (!read.ok) return;
      expect(read.value.overview.name).toBe("demoPack");
      expect(read.value.points.map(({ key }) => key)).toEqual(["notes"]);
    });

    test("finds the pack through the module's exports, a renamed re-export included: the overview's const, under the name the index gives it", async () => {
      const index = `export type { DemoPack } from "./demo.contract.ts";
export { demoPack as demo } from "./demo.pack.ts";
`;
      const given = await fixture({ files: { "packs/demo/index.ts": index } });
      const read = await given.sourceApi.read({ ...request(given.packageDir), exportName: "demo" });
      expect(read.ok ? "ok" : read.error).toBe("ok");
      if (!read.ok) return;
      expect(read.value.overview.name).toBe("demoPack");
      expect(read.value.overview.documentation).toStartWith("The demonstration pack, `demo-package/demo`");
      expect(read.value.points.map(({ key }) => key)).toEqual(["notes"]);
    });

    test("describes an array, a library generic and a record as they are instantiated, never as the generic declaration", async () => {
      const points = `${NOTES_POINT}
  /** Tags. */
  readonly tags: ExtensionPoint<readonly string[], DemoId>;
  /** Names by key. */
  readonly names: ExtensionPoint<Record<string, string>, DemoId>;
  /** Frozen notes. */
  readonly frozenNotes: ExtensionPoint<FrozenNote, DemoId>;`;
      const imports = `import type { NoteJSON } from "./domain/note.contract.ts";
/** A note whose wire form is a Readonly<NoteJSON>. */
export interface FrozenNote {
  readonly __brand: "FrozenNote";
  equals(other: FrozenNote): boolean;
  toJSON(): Readonly<NoteJSON>;
}
`;
      const given = await fixture({ files: { "packs/demo/demo.contract.ts": demoContract(points, imports) } });
      const read = await given.sourceApi.read(request(given.packageDir));
      expect(read.ok ? "ok" : read.error).toBe("ok");
      if (!read.ok) return;
      const schemaOf = (key: string) => read.value.points.find((point) => point.key === key)?.wire?.schema;
      expect(schemaOf("tags")).toMatchObject({ type: "array", items: { type: "string" } });
      expect(schemaOf("names")).toMatchObject({ type: "object", additionalProperties: { type: "string" } });
      expect(JSON.stringify(schemaOf("frozenNotes"))).toContain('"text"');
    });

    test("a point declared through a wrapper alias is described as its real wire type, or refused: never as the alias's type argument", async () => {
      const points = `${NOTES_POINT}
  /** Lists of labels, declared through a wrapper. */
  readonly lists: Wrapped<string>;`;
      const imports = `/** A point of lists of V. */
export type Wrapped<V> = ExtensionPoint<V[], DemoId>;
`;
      const given = await fixture({ files: { "packs/demo/demo.contract.ts": demoContract(points, imports) } });
      const read = await given.sourceApi.read(request(given.packageDir));
      if (read.ok) expect(read.value.points.find(({ key }) => key === "lists")?.wire?.schema).toMatchObject({ type: "array", items: { type: "string" } });
      else expect(read.error).toContain("'lists'");
      expect(read.ok ? JSON.stringify(read.value.points.find(({ key }) => key === "lists")?.wire?.schema) : "refused").not.toBe(JSON.stringify({ type: "string" }));
    });
  });
}
