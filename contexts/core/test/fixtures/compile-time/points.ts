// Extension points declared in their own module and imported by the packs that
// use them, as real packs do. Compiles without errors.
import { ExtensionPoint } from "@bounded/core/domain";

export const BASE = "base";
const base = ExtensionPoint.ownedBy(BASE);
export const words = base.declare<string>({ id: "base.words", description: "Words" });
export const sizes = base.declare<number>({ id: "base.sizes", description: "Sizes", check: (n) => (n > 0 ? undefined : "a size is positive") });
export const tags = ExtensionPoint.ownedBy("tags").declare<string>({ id: "tags.names", description: "Tag names" });
