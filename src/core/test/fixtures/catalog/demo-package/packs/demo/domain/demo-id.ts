import { type PackId, packIdsFor } from "bounded/domain";

/** The demonstration pack's id, `demo-package/demo`. */
export type DemoId = PackId<"demo-package/demo">;
export const demoId: DemoId = packIdsFor("demo-package")("demo");
