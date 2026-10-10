import type { packageCatalogBrand } from "./package-catalog.contract.ts";
import { z } from "zod";
import { readSafely } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import type * as Contract from "./package-catalog.contract.ts";

// Wire contract, version 1: kept inside the module, since a zod schema cannot be frozen.
// Objects strip the fields they do not know, so a reader of version 1 takes what it knows.
const text = z.string();
const filled = (what: string) => z.string().refine((given) => given.trim() !== "", { message: `${what} must not be blank` });
const pointSchema = z.object({
  id: filled("a point's id"),
  key: filled("a point's key"),
  description: text,
  documentation: text,
  valueType: filled("a point's valueType"),
  wire: z.object({ type: filled("a point's wire type"), schema: z.record(z.string(), z.unknown()) }).nullable(),
});
const portSchema = z.object({ id: filled("a port's id"), key: filled("a port's key"), adapterType: filled("a port's adapterType"), documentation: text, declaration: filled("a port's declaration") });
const readmeSchema = z.object({
  path: filled("readme.path"),
  introduction: text,
  whatItIsFor: filled("readme.whatItIsFor"),
  ruleShape: filled("readme.ruleShape"),
  workflowsItFits: filled("readme.workflowsItFits"),
  whatItObserves: filled("readme.whatItObserves"),
  whatItCannotSee: filled("readme.whatItCannotSee"),
  ports: filled("readme.ports"),
  examples: filled("readme.examples"),
  otherSections: z.array(z.object({ heading: filled("a section's heading"), markdown: text })),
});
const exampleSchema = z.object({ path: filled("an example's path"), title: filled("an example's title"), description: text, source: filled("an example's source") });
const packSchema = z.object({
  id: filled("a pack's id"),
  importPath: filled("a pack's importPath"),
  exportName: filled("a pack's exportName"),
  summary: filled("a pack's summary"),
  documentation: text,
  dependsOn: z.array(text),
  contributesTo: z.array(text),
  points: z.array(pointSchema),
  ports: z.array(portSchema),
  optionalPorts: z.array(portSchema).optional(),
  readme: readmeSchema,
  examples: z.array(exampleSchema).min(1, { message: "a pack has at least one example" }),
});
const catalogSchema = z.object({
  catalogVersion: z.literal(1, { message: "catalogVersion must be the number 1" }),
  package: z.object({ name: filled("package.name"), version: filled("package.version") }),
  packs: z.array(packSchema),
}) satisfies z.ZodType<Contract.PackageCatalogJSON>;

/** A zod issue as one line: where it is, and what is wrong. */
const issueText = (issue: z.core.$ZodIssue): string => `${issue.path.length === 0 ? "the catalogue" : issue.path.map(String).join(".")}: ${issue.message}`;

/** A copy of plain data, every object and list in it frozen. */
function frozen<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const item of Object.values(value)) frozen(item);
  return Object.freeze(value);
}

class PackageCatalogImpl implements Contract.PackageCatalog {
  declare readonly __brand: "PackageCatalog";
  declare readonly [packageCatalogBrand]: true;
  readonly #made = true;
  readonly catalogVersion: 1;
  readonly package: { readonly name: string; readonly version: string };
  readonly packs: readonly Contract.CataloguedPackJSON[];

  private constructor(catalog: Contract.PackageCatalogJSON) {
    this.catalogVersion = catalog.catalogVersion;
    this.package = catalog.package;
    this.packs = catalog.packs;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is PackageCatalogImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.PackageCatalog> {
    return readSafely<Contract.PackageCatalog>("A package catalogue", () => {
      const given = PackageCatalogImpl.made(raw) ? wireFormOf(raw) : raw;
      const parsed = catalogSchema.safeParse(given);
      if (!parsed.success) return { ok: false, error: `A package catalogue (catalogVersion 1) is { catalogVersion, package, packs }: ${parsed.error.issues.map(issueText).join("; ")}` };
      const { name } = parsed.data.package;
      const seen = new Set<string>();
      for (const pack of parsed.data.packs) {
        if (seen.has(pack.id)) return { ok: false, error: `A package catalogue lists the pack ${pack.id} twice: each pack appears once` };
        seen.add(pack.id);
        const twice = (pack.optionalPorts ?? []).find((optional) => pack.ports.some((port) => port.key === optional.key));
        if (twice !== undefined) return { ok: false, error: `A package catalogue lists the port ${twice.key} of ${pack.id} both in ports and in optionalPorts: a port is required or optional` };
        if (!pack.id.startsWith(`${name}/`)) return { ok: false, error: `A package catalogue of ${name} lists the pack ${pack.id}, whose id is not rooted at the package's name: build its id with packIdsFor("${name}")` };
      }
      // zod's output is a new object, never the input: freezing it freezes nothing the caller holds.
      const data = frozen(parsed.data);
      return { ok: true, value: new PackageCatalogImpl(data) };
    });
  }

  equals(other: Contract.PackageCatalog): boolean {
    try {
      return sameWire(this, other);
    } catch {
      return false;
    }
  }

  toJSON(): Contract.PackageCatalogJSON {
    return { catalogVersion: this.catalogVersion, package: this.package, packs: this.packs };
  }
}

export type PackageCatalog = Contract.PackageCatalog;
export const PackageCatalog: Contract.PackageCatalogFactory = PackageCatalogImpl;
