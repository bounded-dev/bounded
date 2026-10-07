// Compiles without errors: a pack contributes to its own extension point and
// to the extension point of a pack it declares as a dependency.
import { Contribution, ExtensionPoint, Pack } from "@bounded/core/domain";

const words = ExtensionPoint.ownedBy("base").declare<string>({ id: "base.words", description: "Words" });
const tags = ExtensionPoint.ownedBy("ext").declare<number>({ id: "ext.tags", description: "Tags" });

export const base = new Pack({ name: "base", declares: [words], contributes: [new Contribution(words, ["alpha"])] });
export const ext = new Pack({
  name: "ext",
  dependsOn: ["base"],
  declares: [tags],
  contributes: [new Contribution(words, ["beta"]), new Contribution(tags, [1, 2])],
});
