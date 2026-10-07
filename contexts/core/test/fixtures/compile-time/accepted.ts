// The legitimate forms. Compiles without errors.
import { type Composition, contribution, definePack, packIdsFor, point, type Result } from "bounded/domain";
import { base, ext, packId, tags, text } from "./packs.ts";

// Ids come from one factory per npm package, scoped or not.
export const scoped = packIdsFor("@acme/rules")("web");

// Contributions to points of packs listed directly in dependsOn, values of
// exactly the point's type, nested types included.
export const both = definePack({
  id: packId("both"),
  dependsOn: [base, tags],
  contributes: [
    contribution(base.points.words, ["beta"]),
    contribution(base.points.rules, [{ paths: ["generated/**"], owner: { name: "generator" } }]),
    contribution(tags.points.names, ["extra"]),
  ],
});

// A pack gives values to its own points in point({ values }); a check may
// return unknown, which forces readers to narrow the values they read.
export const own = definePack({
  id: packId("own"),
  points: {
    protectedPaths: point({ description: "Paths", check: text, values: [".git/**"] }),
    anything: point({ description: "Opaque values", check: (raw: unknown): Result<unknown> => ({ ok: true, value: raw }) }),
  },
});

// An empty dependsOn contributes nothing; depending on ext is not depending on base.
export const alone = definePack({ id: packId("alone"), dependsOn: [] });
export const onTop = definePack({ id: packId("on-top"), dependsOn: [ext] });

// Reads are typed by the point object: no cast in the caller.
export function words(composition: Composition): readonly string[] {
  const read = composition.read(base.points.words);
  return read.ok ? read.value : [];
}

// Built-in types are precise values: only their type arguments are inspected
// for any, never the library's own method signatures.
const parsed = <T>() => (raw: unknown): Result<T> => ({ ok: false, error: `not checked in this fixture: ${String(raw)}` });
export const builtIns = definePack({
  id: packId("built-ins"),
  points: {
    dates: point({ description: "Dates", check: parsed<Date>() }),
    patterns: point({ description: "Patterns", check: parsed<RegExp>() }),
    links: point({ description: "Links", check: parsed<URL>() }),
    bytes: point({ description: "Bytes", check: parsed<Uint8Array>() }),
    names: point({ description: "Names", check: parsed<ReadonlySet<string>>() }),
    counts: point({ description: "Counts", check: parsed<ReadonlyMap<string, number>>() }),
    later: point({ description: "Later", check: parsed<Promise<string>>() }),
    guards: point({ description: "Guard-like functions", check: parsed<(event: { readonly path: string }) => Promise<{ readonly allow: boolean }>>() }),
    makers: point({ description: "Constructors", check: parsed<new (name: string) => { readonly name: string }>() }),
  },
});
