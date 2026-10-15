import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { PackageCatalog } from "./package-catalog.ts";

const readme = {
  path: "packs/demo/README.md",
  introduction: "",
  whatItIsFor: "Keeping notes.",
  ruleShape: "Contribute to `notes`.",
  workflowsItFits: "Any.",
  whatItObserves: "Nothing.",
  whatItCannotSee: "Everything.",
  ports: "None.",
  examples: "`basic.config.ts`, `basic.scenarios.ts`",
  otherSections: [],
};
const pack = {
  id: "demo-package/demo",
  importPath: "demo-package/demo",
  exportName: "demoPack",
  summary: "a demonstration pack",
  documentation: "",
  dependsOn: ["bounded/core"],
  contributesTo: [],
  points: [{ id: "demo-package/demo.notes", key: "notes", description: "Notes", documentation: "", valueType: "Note", wire: { type: "NoteJSON", schema: { type: "object" } } }],
  ports: [],
  readme,
  examples: [
    {
      path: "packs/demo/examples/basic.config.ts",
      title: "Keep a note",
      description: "",
      source: "export default 1;\n",
      scenarios: [{ title: "A read is allowed", projectFiles: {}, steps: [{ toolUse: { role: null, tool: "read", effects: [{ kind: "read", path: "README.md" }] }, verdict: { kind: "allow" } }] }],
    },
  ],
};
const one = { catalogVersion: 1, package: { name: "demo-package", version: "1.0.0" }, packs: [pack] };
const two = { catalogVersion: 1, package: { name: "demo-package", version: "1.1.0" }, packs: [pack, { ...pack, id: "demo-package/other", importPath: "demo-package/other", exportName: "otherPack", points: [] }] };

valueObjectLaws("PackageCatalog", PackageCatalog, [one, two], [{ ...one, catalogVersion: 2 }, { ...one, packs: [{ ...pack, examples: [] }] }, { ...one, packs: [{ ...pack, examples: [{ ...pack.examples[0], scenarios: [] }] }] },{ ...one, packs: [pack, pack] }, "catalogue"]);
