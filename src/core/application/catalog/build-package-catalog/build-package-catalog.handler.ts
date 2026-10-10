import { type BasePack, type CataloguedExampleJSON, type CataloguedPackJSON, type ListedPack, PackageCatalog, PackageManifest, PackDescription, PackReadme, parsePack, type Result } from "bounded/domain";
import type { BuildPackageCatalog, BuildPackageCatalogCommand, BuiltPackageCatalog, MarkdownSections, PackageCatalogFiles, PackModules, PackSourceApi, PackSourceApiReading } from "./build-package-catalog.contract.ts";

/** A pack an export path exports, with the name it is exported under. */
interface ExportedPack {
  readonly listed: ListedPack;
  readonly exportName: string;
  readonly pack: BasePack;
  readonly description: PackDescription;
}

const refused = (error: string): { readonly ok: false; readonly error: string } => ({ ok: false, error });
/** The keys two lists disagree on, as text: `a, b` in one and not the other. */
const onlyIn = (keys: readonly string[], others: readonly string[]): string[] => keys.filter((key) => !others.includes(key));

export class BuildPackageCatalogHandler implements BuildPackageCatalog {
  constructor(
    private readonly files: PackageCatalogFiles,
    private readonly modules: PackModules,
    private readonly sourceApi: PackSourceApi,
    private readonly markdown: MarkdownSections,
  ) {}

  async execute(command: BuildPackageCatalogCommand): Promise<Result<BuiltPackageCatalog>> {
    const { packageDir } = command;
    const raw = await this.files.readManifest(packageDir);
    if (!raw.ok) return raw;
    const manifest = PackageManifest.parse(raw.value);
    if (!manifest.ok) return manifest;
    const exported: ExportedPack[] = [];
    for (const listed of manifest.value.packs) {
      const pack = await this.exportedPack(packageDir, listed);
      if (!pack.ok) return pack;
      exported.push(pack.value);
    }
    exported.sort((a, b) => (a.description.id < b.description.id ? -1 : a.description.id > b.description.id ? 1 : 0));
    const entries: CataloguedPackJSON[] = [];
    for (const pack of exported) {
      const entry = await this.entryFor(packageDir, manifest.value, pack);
      if (!entry.ok) return entry;
      entries.push(entry.value);
    }
    const catalog = PackageCatalog.parse({ catalogVersion: 1, package: { name: manifest.value.name, version: manifest.value.version }, packs: entries });
    if (!catalog.ok) return catalog;
    const written = await this.files.write(packageDir, manifest.value.catalogPath, `${JSON.stringify(catalog.value, null, 2)}\n`);
    if (!written.ok) return written;
    return { ok: true, value: { path: written.value, catalog: catalog.value } };
  }

  /** The one pack an export path listed in bounded.packs exports, or why it exports none or several. */
  private async exportedPack(packageDir: string, listed: ListedPack): Promise<Result<ExportedPack>> {
    const loaded = await this.modules.load(packageDir, listed.exportPath);
    if (!loaded.ok) return loaded;
    const packs: { readonly exportName: string; readonly pack: BasePack }[] = [];
    for (const { name, value } of loaded.value) {
      const pack = parsePack(value);
      if (pack.ok && !packs.some((known) => known.pack === pack.value)) packs.push({ exportName: name, pack: pack.value });
    }
    const [only, ...more] = packs;
    if (only === undefined) return refused(`${listed.exportPath} exports no pack made with definePack by this copy of bounded: an export path bounded.packs lists exports exactly one pack`);
    if (more.length > 0) return refused(`${listed.exportPath} exports ${packs.length} packs (${packs.map(({ exportName }) => exportName).join(", ")}): an export path bounded.packs lists exports exactly one pack; give each pack an export path of its own`);
    return { ok: true, value: { listed, exportName: only.exportName, pack: only.pack, description: PackDescription.of(only.pack) } };
  }

  /** A pack's catalogue entry: the pack object's description, its typed API, its README and its examples. */
  private async entryFor(packageDir: string, manifest: PackageManifest, exported: ExportedPack): Promise<Result<CataloguedPackJSON>> {
    const { listed, description } = exported;
    const { id } = description;
    const { packDir } = listed;
    if (!id.startsWith(`${manifest.name}/`)) return refused(`${listed.exportPath} exports the pack ${id}, whose id is not rooted at the package's name, ${manifest.name}: build its id with packIdsFor("${manifest.name}")`);
    const examplePaths = await this.files.listExamples(packageDir, packDir);
    if (!examplePaths.ok) return examplePaths;
    if (examplePaths.value.length === 0) return refused(`${id} has no example: add ${packDir}/examples/<slug>.config.ts, a complete bounded.config.ts the package's tests open as a project's configuration`);
    const api = await this.sourceApi.read({ packageDir, packDir, exportName: exported.exportName, examplePaths: examplePaths.value });
    if (!api.ok) return refused(`${id}: ${api.error}`);
    const disagreement = this.disagreement(id, packDir, description, api.value);
    if (disagreement !== undefined) return refused(disagreement);
    const readme = await this.readmeOf(packageDir, packDir, description);
    if (!readme.ok) return readme;
    const examples: CataloguedExampleJSON[] = [];
    for (const path of examplePaths.value) {
      const example = await this.exampleAt(packageDir, id, path, api.value);
      if (!example.ok) return example;
      examples.push(example.value);
    }
    const pointsByKey = new Map(api.value.points.map((point) => [point.key, point]));
    const portsByKey = new Map(api.value.ports.map((port) => [port.key, port]));
    return {
      ok: true,
      value: {
        id,
        importPath: `${manifest.name}${listed.exportPath.slice(1)}`,
        exportName: exported.exportName,
        summary: readme.value.summary,
        documentation: api.value.overview.documentation,
        dependsOn: description.dependsOn,
        contributesTo: description.contributesTo,
        points: description.points.map((point) => {
          const typed = pointsByKey.get(point.key);
          return { id: point.id, key: point.key, description: point.description, documentation: typed?.documentation ?? "", valueType: typed?.valueType ?? "", wire: typed?.wire ?? null };
        }),
        ports: description.ports.map((port) => {
          const typed = portsByKey.get(port.key);
          return { id: port.id, key: port.key, adapterType: typed?.adapterType ?? "", documentation: typed?.documentation ?? "", declaration: typed?.declaration ?? "" };
        }),
        readme: readme.value.toJSON(),
        examples,
      },
    };
  }

  /** Why the pack's contract and its pack object disagree on its point or port keys, or undefined when they agree. */
  private disagreement(id: string, packDir: string, description: PackDescription, api: PackSourceApiReading): string | undefined {
    const contract = `${packDir}/${packDir.split("/").at(-1) ?? ""}.contract.ts`;
    for (const [what, objectKeys, contractKeys] of [
      ["point", description.points.map(({ key }) => key), api.points.map(({ key }) => key)],
      ["port", description.ports.map(({ key }) => key), api.ports.map(({ key }) => key)],
    ] as const) {
      const onlyContract = onlyIn(contractKeys, objectKeys);
      const onlyObject = onlyIn(objectKeys, contractKeys);
      if (onlyContract.length > 0 || onlyObject.length > 0) {
        return `${id}: its contract (${contract}) and its pack object disagree on its ${what} keys: the contract gives ${contractKeys.join(", ") || "none"}, the pack object ${objectKeys.join(", ") || "none"}. Make the pack's type in its contract declare exactly the ${what}s its overview gives`;
      }
    }
    return undefined;
  }

  /** The pack's README, read by the Markdown reader and checked by the README rules. */
  private async readmeOf(packageDir: string, packDir: string, description: PackDescription): Promise<Result<PackReadme>> {
    const path = `${packDir}/README.md`;
    const text = await this.files.readText(packageDir, path);
    if (!text.ok) return refused(`${description.id}: ${text.error}`);
    if (text.value === null) {
      return refused(`${description.id} has no README at ${path}: add one titled \`# ${description.id}: <one-line summary>\`, with the sections What it is for, Rule shape, Workflows it fits, What it observes, What it cannot see, Ports and Examples`);
    }
    const document = await this.markdown.read(packageDir, text.value);
    if (!document.ok) return refused(`${description.id}: ${path}: ${document.error}`);
    return PackReadme.parse({
      packId: description.id,
      path,
      title: document.value.title,
      introduction: document.value.introduction,
      sections: document.value.sections,
      pointKeys: description.points.map(({ key }) => key),
      portKeys: description.ports.map(({ key }) => key),
    });
  }

  /** An example, embedded verbatim, titled by the first line of the TSDoc on its default export. */
  private async exampleAt(packageDir: string, id: string, path: string, api: PackSourceApiReading): Promise<Result<CataloguedExampleJSON>> {
    const source = await this.files.readText(packageDir, path);
    if (!source.ok) return refused(`${id}: ${source.error}`);
    if (source.value === null) return refused(`${id}: ${path} could not be read: it was listed as an example, then disappeared`);
    const documentation = api.examples.find((example) => example.path === path)?.documentation ?? "";
    const [title = "", ...rest] = documentation.split("\n");
    if (title.trim() === "") return refused(`${id}: ${path} has no TSDoc title on its default export: begin the TSDoc above \`export default\` with a one-line title, then a blank line and what the example does`);
    return { ok: true, value: { path, title: title.trim(), description: rest.join("\n").trim(), source: source.value } };
  }
}
