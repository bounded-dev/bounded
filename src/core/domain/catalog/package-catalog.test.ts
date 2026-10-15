import { describe, expect, test } from "bun:test";
import { PackageCatalog } from "./package-catalog.ts";

/** A whole catalogue as a build writes it: one package, one pack. */
const sample = {
  catalogVersion: 1,
  package: { name: "demo-package", version: "1.0.0" },
  packs: [
    {
      id: "demo-package/demo",
      importPath: "demo-package/demo",
      exportName: "demoPack",
      summary: "a demonstration pack",
      documentation: "The demonstration pack.",
      dependsOn: ["bounded/core"],
      contributesTo: ["bounded/core.beforeTool"],
      points: [
        {
          id: "demo-package/demo.notes",
          key: "notes",
          description: "Notes a project keeps",
          documentation: "Notes: one line of text each.",
          valueType: "Note",
          wire: { type: "NoteJSON", schema: { $ref: "#/definitions/NoteJSON", definitions: { NoteJSON: { type: "object" } } } },
        },
        { id: "demo-package/demo.hooks", key: "hooks", description: "Code run around a call", documentation: "", valueType: "NoteHook", wire: null },
      ],
      ports: [{ id: "demo-package/demo#noteStore", key: "noteStore", adapterType: "NoteStore", documentation: "Where notes are kept.", declaration: "interface NoteStore {\n  save(text: string): Promise<void>;\n}" }],
      readme: {
        path: "packs/demo/README.md",
        introduction: "A pack for the tests.",
        whatItIsFor: "Keeping notes.",
        ruleShape: "Contribute to `notes`.",
        workflowsItFits: "Any.",
        whatItObserves: "Nothing.",
        whatItCannotSee: "Everything.",
        ports: "`noteStore`",
        examples: "`basic.config.ts`, `basic.scenarios.ts`",
        otherSections: [{ heading: "Records", markdown: "None are kept." }],
      },
      examples: [
        {
          path: "packs/demo/examples/basic.config.ts",
          title: "Keep a note",
          description: "The project keeps one note.",
          source: "export default 1;\n",
          scenarios: [{ title: "A read is allowed", projectFiles: {}, steps: [{ toolUse: { role: null, tool: "read", effects: [{ kind: "read", path: "README.md" }] }, verdict: { kind: "allow" } }] }],
        },
      ],
    },
  ],
} as const;

type Sample = typeof sample;
type Pack = Sample["packs"][number];
const withPack = (change: (pack: Record<string, unknown>) => Record<string, unknown>): unknown => ({ ...sample, packs: [change({ ...sample.packs[0] })] });
const refusal = (raw: unknown): string => {
  const parsed = PackageCatalog.parse(raw);
  return parsed.ok ? "accepted" : parsed.error;
};

describe("PackageCatalog — a package's catalogue of its packs (ADR 2026-029)", () => {
  test("a full sample round-trips: its wire form is what was given", () => {
    const parsed = PackageCatalog.parse(sample);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect<unknown>(parsed.value.toJSON()).toEqual(sample);
    expect(JSON.parse(JSON.stringify(parsed.value))).toEqual(sample);
    expect(parsed.value.catalogVersion).toBe(1);
    expect(parsed.value.packs.map((pack) => pack.id)).toEqual(["demo-package/demo"]);
  });

  test("a catalogVersion of 2, \"1\", or none at all is refused", () => {
    for (const catalogVersion of [2, "1", undefined]) expect(refusal({ ...sample, catalogVersion })).toContain("catalogVersion");
    const { catalogVersion: _version, ...withoutVersion } = sample;
    expect(refusal(withoutVersion)).toContain("catalogVersion");
  });

  test("a duplicate pack id is refused, naming it", () => {
    const error = refusal({ ...sample, packs: [sample.packs[0], sample.packs[0]] });
    expect(error).toContain("demo-package/demo");
    expect(error).toContain("twice");
  });

  test("a pack id not rooted at the package's name is refused, naming both", () => {
    const error = refusal(withPack((pack) => ({ ...pack, id: "other-package/demo" })));
    expect(error).toContain("other-package/demo");
    expect(error).toContain("demo-package");
  });

  const readmeFields = ["path", "whatItIsFor", "ruleShape", "workflowsItFits", "whatItObserves", "whatItCannotSee", "ports", "examples"] as const;
  test("a missing or blank readme field is refused, naming the field", () => {
    for (const field of readmeFields) {
      const { [field]: _dropped, ...without } = sample.packs[0].readme;
      expect({ field, error: refusal(withPack((pack) => ({ ...pack, readme: without }))).includes(field) }).toEqual({ field, error: true });
      expect({ field, error: refusal(withPack((pack) => ({ ...pack, readme: { ...sample.packs[0].readme, [field]: "  " } }))).includes(field) }).toEqual({ field, error: true });
    }
  });

  test("a pack with no examples is refused", () => {
    expect(refusal(withPack((pack) => ({ ...pack, examples: [] })))).toContain("example");
  });

  test("keeps each example's scenarios", () => {
    const parsed = PackageCatalog.parse(sample);
    expect(parsed.ok ? parsed.value.packs[0]?.examples[0]?.scenarios : parsed.error).toEqual(sample.packs[0].examples[0].scenarios);
    const asGiven = [{ title: "Kept as given", steps: [{ anything: "the build checked it" }], extra: 1 }];
    const kept = PackageCatalog.parse(withPack((pack) => ({ ...pack, examples: [{ ...sample.packs[0].examples[0], scenarios: asGiven }] })));
    expect(kept.ok ? kept.value.packs[0]?.examples[0]?.scenarios : kept.error).toEqual(asGiven);
  });

  test("refuses an example without scenarios, or with an empty list, naming the pack and the example", () => {
    const { scenarios: _scenarios, ...withoutScenarios } = sample.packs[0].examples[0];
    for (const example of [withoutScenarios, { ...withoutScenarios, scenarios: [] }]) {
      const error = refusal(withPack((pack) => ({ ...pack, examples: [example] })));
      expect({ example, names: [error.includes("demo-package/demo"), error.includes("packs/demo/examples/basic.config.ts"), error.includes("scenarios")] }).toEqual({ example, names: [true, true, true] });
    }
    for (const scenarios of [[{ title: "No steps", steps: [] }], [{ title: "No steps" }], ["a scenario"]]) {
      expect({ scenarios, error: refusal(withPack((pack) => ({ ...pack, examples: [{ ...withoutScenarios, scenarios }] }))) }).toEqual({ scenarios, error: expect.stringContaining("scenarios") });
    }
  });

  test("unknown fields are ignored: readers of version 1 take what they know", () => {
    const later = { ...sample, published: "2026-10-10", packs: [{ ...sample.packs[0], tags: ["notes"], readme: { ...sample.packs[0].readme, faq: "none" } }] };
    const parsed = PackageCatalog.parse(later);
    expect(parsed.ok).toBe(true);
    expect<unknown>(parsed.ok && parsed.value.toJSON()).toEqual(sample);
  });

  test("a parsed catalogue is frozen, its packs too", () => {
    const parsed = PackageCatalog.parse(sample);
    expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true);
    expect(parsed.ok && Object.isFrozen(parsed.value.packs)).toBe(true);
    expect(parsed.ok && Object.isFrozen(parsed.value.packs[0] as Pack)).toBe(true);
  });

  test("a pack's optional ports round-trip beside its ports; a key in both is refused", () => {
    const optionalPort = { id: "demo-package/demo#statusSnapshots", key: "statusSnapshots", adapterType: "StatusSnapshots", documentation: "Where the status is saved.", declaration: "interface StatusSnapshots {\n  save(): Promise<void>;\n}" };
    const withOptional = withPack((pack) => ({ ...pack, optionalPorts: [optionalPort] }));
    const parsed = PackageCatalog.parse(withOptional);
    expect(parsed.ok ? "ok" : parsed.error).toBe("ok");
    expect<unknown>(parsed.ok && parsed.value.toJSON()).toEqual(withOptional);
    const twice = withPack((pack) => ({ ...pack, optionalPorts: [{ ...optionalPort, id: "demo-package/demo#noteStore", key: "noteStore" }] }));
    expect(refusal(twice)).toContain("noteStore");
  });
});
