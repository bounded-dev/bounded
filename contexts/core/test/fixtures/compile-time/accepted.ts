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
