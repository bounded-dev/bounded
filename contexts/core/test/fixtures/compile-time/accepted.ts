// The legitimate forms. Compiles without errors.
import { type Composition, contribution, definePack } from "@bounded/core/domain";
import { base, ext, tags } from "./packs.ts";

// Contributions to points of packs listed directly in dependsOn, values of
// exactly the point's type, nested types included.
const LABEL = "both";
export const both = definePack({
  id: LABEL,
  dependsOn: [base, tags],
  contributes: [
    contribution(base.points.words, ["beta"]),
    contribution(base.points.rules, [{ paths: ["generated/**"], owner: { name: "generator" } }]),
    contribution(tags.points.names, ["extra"]),
  ],
});

// A pack contributing to its own point gives the values in point({ values })
// (see packs.ts). A pack with an empty dependsOn contributes nothing.
export const alone = definePack({ id: "alone", dependsOn: [] });
export const onTop = definePack({ id: "on-top", dependsOn: [ext] });

// Reads are typed by the point object: no cast in the caller.
export function words(composition: Composition): readonly string[] {
  const read = composition.read(base.points.words);
  return read.ok ? read.value : [];
}
