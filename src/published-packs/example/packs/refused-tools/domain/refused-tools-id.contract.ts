import type { PackId } from "bounded/domain";

/** The refused-tools pack's id, `bounded-example/refused-tools`: rooted at its own package (ADR 2026-004), declared before the pack. */
export type RefusedToolsId = PackId<"bounded-example/refused-tools">;
