import { describe, expect, test } from "bun:test";
import { PackageManifest } from "./package-manifest.ts";

const manifest = { name: "demo-package", version: "1.0.0", type: "module", bounded: { catalog: "./bounded.catalog.json", packs: { "./demo": "packs/demo" } } };
const refusal = (raw: unknown): string => {
  const parsed = PackageManifest.parse(raw);
  return parsed.ok ? "accepted" : parsed.error;
};

describe("PackageManifest — what the package catalogue build reads of package.json", () => {
  test("gives the name, version, catalogue path and each listed pack, its other fields ignored", () => {
    const parsed = PackageManifest.parse({ ...manifest, bounded: { ...manifest.bounded, packs: { "./demo": "./packs/demo/", "./other": "packs/other" } } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect({ name: parsed.value.name, version: parsed.value.version, catalogPath: parsed.value.catalogPath }).toEqual({ name: "demo-package", version: "1.0.0", catalogPath: "bounded.catalog.json" });
    expect(parsed.value.packs).toEqual([
      { exportPath: "./demo", packDir: "packs/demo" },
      { exportPath: "./other", packDir: "packs/other" },
    ]);
    expect(parsed.value.toJSON()).toEqual({ name: "demo-package", version: "1.0.0", bounded: { catalog: "./bounded.catalog.json", packs: { "./demo": "packs/demo", "./other": "packs/other" } } });
  });

  test("refuses a package.json with no bounded.packs, saying what to add", () => {
    const { bounded: _bounded, ...withoutBounded } = manifest;
    for (const raw of [withoutBounded, { ...manifest, bounded: { catalog: "./bounded.catalog.json" } }, { ...manifest, bounded: { ...manifest.bounded, packs: {} } }, { ...manifest, bounded: "yes" }]) {
      expect(refusal(raw)).toContain("package.json has no bounded.packs");
      expect(refusal(raw)).toContain('"packs": { "./<export path>": "<pack directory>" }');
    }
  });

  test("refuses a manifest that is not an object, or has no name or version", () => {
    expect(refusal([])).toBe("package.json is not a JSON object");
    expect(refusal({ ...manifest, name: undefined })).toContain("no name and version");
    expect(refusal({ ...manifest, version: " " })).toContain("no name and version");
  });

  test("refuses a catalogue path or pack directory outside the package, and an export path not written as one", () => {
    for (const catalog of [undefined, "../bounded.catalog.json", "/tmp/bounded.catalog.json", "./bounded.catalog.txt"]) expect(refusal({ ...manifest, bounded: { ...manifest.bounded, catalog } })).toContain("bounded.catalog");
    expect(refusal({ ...manifest, bounded: { ...manifest.bounded, packs: { "./demo": "../elsewhere" } } })).toContain("'../elsewhere'");
    expect(refusal({ ...manifest, bounded: { ...manifest.bounded, packs: { demo: "packs/demo" } } })).toContain("'demo', which is not an export path");
  });
});
