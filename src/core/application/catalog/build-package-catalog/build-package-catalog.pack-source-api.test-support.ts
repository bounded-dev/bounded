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
const request = (packageDir: string) => ({ packageDir, packDir: "packs/demo", examplePaths: [EXAMPLE] });

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
  });
}
