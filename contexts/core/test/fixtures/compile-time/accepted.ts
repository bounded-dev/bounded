// Compiles without errors: packs contribute to their own extension points and
// to those of packs they declare as dependencies.
import { Contribution, Pack } from "@bounded/core/domain";
import { BASE, sizes, tags, words } from "./points.ts";

// A pack that only declares, its name held in a constant.
export const base = new Pack({ name: BASE, declares: [words, sizes] });
export const tagPack = new Pack({ name: "tags", declares: [tags], contributes: [new Contribution(tags, ["core"])] });

// Several dependencies, contributing to each.
export const ext = new Pack({
  name: "ext",
  dependsOn: [BASE, "tags"],
  contributes: [new Contribution(words, ["beta"]), new Contribution(sizes, [1, 2]), new Contribution(tags, ["extra"])],
});

// No dependencies at all.
export const plain = new Pack({ name: "plain" });
