# 2026-029: Each package ships a catalogue of its packs, `bounded.catalog.json`, built from the pack objects, their contracts and READMEs

**Status:** accepted (issue #68, step 1 (B), `pack-catalogue`; the plan's
review, and the maintainer's answers to its two open questions, marked
below). Ships in `bounded` 3.3.0, unreleased, with no version bump of its
own. Amends [ADR 2026-016](2026-016-cli-app.md): the CLI gains
`bounded catalog build`, and bounded's prepack runs it after building
`dist/`.

## Context

Issue #68 asks for a pack catalogue that agents and people can use to find
packs and read everything about each one. Packs may live in other packages,
so there is no registry service: each package ships its own catalogue, and
npm is the transport. The `pack-structure` item gave every shipped pack a
README with seven required sections and tested examples
(`examples/<slug>.config.ts`). This decision is the format those are joined
into, and the build that joins them.

Later steps read this format: `bounded packs` and `bounded packs show` (the
installed and included packages' catalogues), an npm search over packages
with the `bounded-pack` keyword, `bounded guide`, and the website. It is the
contract every one of them reads.

## Decision

### The format, version 1

`bounded.catalog.json`, at the path the package's `bounded.catalog` names:

```json
{
  "catalogVersion": 1,
  "package": { "name": "bounded", "version": "3.3.0" },
  "packs": [{
    "id": "bounded/prereqs",
    "importPath": "bounded/prereqs",
    "exportName": "prereqs",
    "summary": "an action needs a prerequisite",
    "documentation": "<the TSDoc on the pack in its overview>",
    "dependsOn": ["bounded/core"],
    "contributesTo": ["bounded/core.beforeTool", "bounded/core.afterTool", "bounded/core.onAgentRunFinish"],
    "points": [{
      "id": "bounded/prereqs.rules", "key": "rules",
      "description": "<the point's own description>", "documentation": "<the contract's TSDoc on it>",
      "valueType": "PrerequisiteRule",
      "wire": { "type": "PrerequisiteRuleJSON", "schema": { "$ref": "#/definitions/PrerequisiteRuleJSON", "definitions": { } } }
    }],
    "ports": [{
      "id": "bounded/prereqs#fileSetFingerprints", "key": "fileSetFingerprints",
      "adapterType": "FileSetFingerprints", "documentation": "<the interface's TSDoc, without tags>",
      "declaration": "interface FileSetFingerprints { … }"
    }],
    "readme": {
      "path": "packs/prereqs/README.md", "introduction": "<before the first section>",
      "whatItIsFor": "…", "ruleShape": "…", "workflowsItFits": "…", "whatItObserves": "…",
      "whatItCannotSee": "…", "ports": "…", "examples": "…",
      "otherSections": [{ "heading": "Records", "markdown": "…" }]
    },
    "examples": [{ "path": "packs/prereqs/examples/review-plan-before-building.config.ts", "title": "…", "description": "…", "source": "<verbatim>" }]
  }]
}
```

- **`catalogVersion` is the integer 1.** Within a version, fields are only
  added, and readers ignore fields they do not know: `PackageCatalog.parse`
  (the core's domain, `bounded/domain`) drops them. A reader refuses any
  other version.
- **One entry per pack** an export path in `bounded.packs` exports, in id
  order. `bounded/core` gets no entry, and contributed values are not
  listed.
- **Paths are package-relative**, and the output is deterministic: the same
  sources give the same bytes.
- **What it takes from where.** From the pack object (`PackDescription`):
  the id, `dependsOn`'s ids, each point's id, key (a group's member as
  `<group>.<member>`, `keyedPointsOf`) and description, the distinct ids of
  the points it contributes to in contribution order, and each port's id.
  From its overview and contract, with TypeScript: the pack's TSDoc, each
  point's value type and TSDoc, each port's adapter interface, its TSDoc and
  declaration. From the README (`PackReadme`): the summary (the title's
  text after `# <pack id>: `) and the sections' Markdown. From each example:
  its source verbatim, and the TSDoc on its default export, whose first line
  is its title.

### `wire.schema` is the compile-time wire shape (maintainer: Q1 (a))

A point holds no zod schema: `point()` keeps a description and a
hand-written `check`. What is exact at compile time is the wire type: a
contribution compiles as `Value | WireOf<Value>` (ADRs 2026-003 and
2026-012). The **wire rule**:

- a value object (it has `__brand` and `toJSON`): its `toJSON` result,
  `WireOf<Value>`;
- plain JSON data: `Value` itself;
- code (the type is or holds a function): `wire: null`.

`wire.type` is the wire type's text as TypeScript prints it (`PrerequisiteRuleJSON`,
`string`, `"low" | "high"`). `ts-json-schema-generator` generates the schema
over the same program, from a node, never by looking a name up (two types
of one name in the program cannot be confused): the declaration the checker
resolved the wire type to, when it is declared under a name (an interface,
type alias, enum or class) and is not an instantiation of a generic,
referenced from the top as `definitions/<name>`; otherwise (`readonly
string[]`, `Readonly<NoteJSON>`, `Record<string, string>`, a type with no
name) where the type is written, described
inline: a value object's `toJSON` return type, or plain data's
`ExtensionPoint<Value, …>` type argument. So a primitive, a union, or an
alias TypeScript does not keep (`type Label = string`) is described as it
stands. The generator runs with `additionalProperties: false` and
`functions: "fail"`; a data point whose type it cannot describe is
refused.

Limits only the run-time check enforces (a glob that compiles, a redirect
of at most 1000 characters) stay in the README's prose and the TSDoc: the
schema says what compiles, not everything the check accepts. Two tests
keep the schema honest
(`src/core/composition-root/pack-wire-schemas.test.ts`): every wire form
the pack's own tests accept validates, and every value the shipped
examples contribute validates; and the generator's rendering of
`?: undefined` (`{ "not": {} }`) keeps a prerequisite rule's `before` to
exactly one action.

**The wire-form lists are copies.** Each shipped pack's
`domain/<concept>.wire-forms.test-support.ts` copies the literal wire forms
its concept tests expect `parse` to accept. A later change should make the
concept tests consume these lists, so they cannot drift apart.

### The build

`bounded catalog build`, run in the package's directory (bounded runs it in
its prepack: `bun build-dist.ts && node dist/cli.js catalog build`), is the
core's application feature `catalog/build-package-catalog`, wired by the
CLI as `bounded init` is (ADR 2026-016). Its four out ports and their
adapters (`bounded/adapters`):

| Port | Adapter | What it does |
| --- | --- | --- |
| `PackageCatalogFiles` | `FileSystemPackageCatalogFiles` | reads package.json, READMEs and examples; lists `examples/*.config.ts`; writes inside the package only |
| `PackModules` | `NodePackModules` | loads an export path's module, as Node loads it |
| `PackSourceApi` | `TypeScriptPackSourceApi` | reads the overview, contract and examples with TypeScript, and generates the wire schemas |
| `MarkdownSections` | `MarkedMarkdownSections` | splits a README into its title, introduction and sections, with their inline code spans and code blocks, with marked's lexer |

For each pack, in id order, it loads exactly one pack from the export
path, describes it, checks its id is rooted at the package's name, reads
its API and checks the contract and pack object agree on every point and
port key, parses its README, and reads its titled examples (at least
one). Then it builds the catalogue, parses it again as a `PackageCatalog`
and writes it. **The first refusal stops it, and nothing is written**; the
CLI prints `bounded: <refusal>` and exits 1.

- **The `bounded` field.** A package lists its packs in package.json:
  `"bounded": { "catalog": "./bounded.catalog.json", "packs": { "./prereqs": "packs/prereqs" } }`,
  each export path that exports a pack (`.` for the package root) with the
  pack's source directory. It
  lists `bounded.catalog.json` in `files` and carries the keyword
  `bounded-pack`. A package.json with no `bounded.packs` is refused.
- **Each listed export path exports exactly one pack**, made by the same
  copy of bounded (`parsePack`). None, or two, is refused, naming them.
- **The export-entry rule (B1).** The build runs under Node. `NodePackModules`
  reads the export path's entry from the package's own package.json, and
  refuses, before resolving anything, an entry with no `default`, `require`
  or `node` target (a path, or conditions holding one at any depth),
  naming the export path and the fix: add a `default` condition. So the
  refusal is the same under bun and Node. The package root, `.`, is
  read from a `.` entry, or from `exports` itself when it is a path or the
  root's conditions; a package with no `exports` loads its root through
  `main`, as Node's require does. Otherwise it resolves the export by self-reference
  (`createRequire(<package>/package.json).resolve(...)`, the bare package
  name for `.`, `<name>/<subpath>` otherwise) and imports it. Each listed export must resolve to JavaScript through
  those conditions: bounded's own reach `dist/` through `default`.
- **Library resolution (maintainer: Q2).** `typescript`,
  `ts-json-schema-generator` and `marked` are the catalogued package's own
  devDependencies, resolved from it (`loadPackageLibrary`, in
  `src/core/adapters/out/package-library.ts`, outside the adapters' barrel)
  and imported. A missing one is refused: "install <name> as a
  devDependency of the package to build its catalogue". bounded declares
  none of them as a dependency or peer, so a project that installs bounded
  downloads none of them; bounded's own prepack finds them in the
  workspace's root devDependencies. No adapter imports them statically, and
  no published declaration names them. ts-json-schema-generator must
  resolve the same copy of `typescript` as the package: it reads the
  program the build compiled. Another copy is refused, naming both
  versions and paths.
- **The tsconfig rule (B2).** The package's `tsconfig.json` is found as
  `tsc` finds it (`ts.findConfigFile`, searching upwards), and only its
  compiler options are taken. The program's root files are the pack's own:
  `<name>.pack.ts`, `<name>.contract.ts` and `examples/*.config.ts`; an
  unrelated file the tsconfig includes, even one with a type error, changes
  nothing. No tsconfig is refused, naming the file to add. The pack's
  `index.ts` is a root too, when it has one: the name the module loader
  found the pack under is looked up among the index's exports by the
  checker, and a re-export, renamed or not, is followed to its declaration,
  which must be an `export const` of the overview. A pack with no index is
  found by that name among the overview's own exports. A pack exported
  under several names is named by one other than `default`.
- **The TypeScript 5 limit (B5), deliberate.** The reader reads TypeScript
  major 5, the major the tests run with, and refuses any other, naming the
  version it found. A later TypeScript major is a change here, with its
  tests.
- **TypeScript and Markdown are bounded's authoring formats; package.json
  is its transport format.** A pack's public API is read from TypeScript,
  its prose from Markdown. The overview stays mechanical (R7): prose stays
  in the README, and the build joins the two. A pack travels as an npm
  package, so package.json's `exports` and Node's condition rules (which
  target `require` picks) decide how a pack is found and loaded; the
  `bounded` field lists which export paths hold packs. `PackModules` keeps
  them behind a port, as the core's ports keep the file system.

### Generated, not committed (maintainer)

`bounded.catalog.json` is generated at pack time and gitignored
(`src/bounded.catalog.json`). bounded's tarball carries it. **Known gap:** a
pack fetched from a git repository (issue #68 §7) carries no catalogue
until it is built there; git transport is a later step.

## Why

The pack objects already say what a pack is, and the contracts say it
exactly; the READMEs say why. Building the catalogue from them, and failing
closed when any part is missing, means the catalogue cannot drift from the
code, and a pack author writes nothing twice. Keeping the build in the core
and the CLI, and the prose in the pack, keeps the core free of content.
Loading the build's libraries from the catalogued package keeps them out of
every project that only uses bounded.

## Consequences

- `bounded/domain` gains `PackageCatalog`, `PackageManifest`,
  `PackDescription`, `PackReadme`, `keyedPointsOf` and `parsePack`;
  `bounded/application` the feature; `bounded/adapters` its four adapters.
- `src/core/composition-root/pack-readmes.test.ts` checks the shipped
  READMEs through `MarkedMarkdownSections` and `PackReadme`, the build's own
  rules; its earlier cases are recorded in `superseded-tests.json`.
- The pack-id check now happens at pack time, in the build. A pack whose id
  is not rooted at its package's name still loads at run time: that check
  is still missing.
- Four test files write the shared, gitignored `src/bounded.catalog.json`:
  `src/core/composition-root/pack-wire-schemas.test.ts` and
  `src/cli/bounded-cli.catalog-bounded.test.ts` (each runs the built CLI's
  `bounded catalog build` in src/), and `src/test/packaging.test.ts` and
  `src/cli/test/bounded-cli.e2e.test.ts` (each packs bounded, whose prepack
  builds it). They rely on `bun test` running files one after another; the
  two that read it rebuild it first.
