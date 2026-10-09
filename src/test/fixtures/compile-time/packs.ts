// Packs in their own module, imported by the fixtures that build on them, as
// real packs are. Compiles without errors.
import { definePack, packIdsFor, point, type Result } from "bounded/domain";

export interface Rule {
  readonly paths: readonly string[];
  readonly owner: { readonly name: string };
}

export const packId = packIdsFor("test-packs");
export const text = (raw: unknown): Result<string> => (typeof raw === "string" ? { ok: true, value: raw } : { ok: false, error: "not text" });
const rule = (raw: unknown): Result<Rule> => ({ ok: false, error: `not checked in this fixture: ${String(raw)}` });

export const base = definePack({
  id: packId("base"),
  points: {
    words: point({ description: "Words", check: text, values: ["alpha"] }),
    rules: point({ description: "Rules", check: rule }),
  },
});

export const tags = definePack({ id: packId("tags"), points: { names: point({ description: "Tag names", check: text }) } });

/** Depends on base only; packs below that depend on ext never depend directly on base. */
export const ext = definePack({ id: packId("ext"), dependsOn: [base] });
