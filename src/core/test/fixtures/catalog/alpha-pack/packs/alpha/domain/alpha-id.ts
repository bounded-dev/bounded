import { type PackId, packIdsFor } from "bounded/domain";

/** The second demonstration pack's id, `demo-package/alpha`: first in id order. */
export type AlphaId = PackId<"demo-package/alpha">;
export const alphaId: AlphaId = packIdsFor("demo-package")("alpha");
