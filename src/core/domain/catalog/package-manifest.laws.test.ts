import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { PackageManifest } from "./package-manifest.ts";

const demo = { name: "demo-package", version: "1.0.0", bounded: { catalog: "./bounded.catalog.json", packs: { "./demo": "packs/demo" } } };
valueObjectLaws(
  "PackageManifest",
  PackageManifest,
  [demo, { name: "bounded", version: "3.3.0", bounded: { catalog: "./bounded.catalog.json", packs: { "./prereqs": "packs/prereqs", "./protected-paths": "packs/protected-paths" } } }],
  [{ ...demo, bounded: { catalog: "./bounded.catalog.json", packs: {} } }, { ...demo, name: "" }, "package.json"],
);
