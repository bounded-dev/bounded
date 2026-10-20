import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type TypeEnvironment = {
  readonly standardLibraries: Readonly<Record<string, Uint8Array>>;
  readonly externalDeclarations: Readonly<Record<string, Uint8Array>>;
};
type Manifest = {
  readonly schema: string;
  readonly typescriptVersion: string;
  readonly nodeTypesVersion: string;
  readonly undiciTypesVersion: string;
  readonly treeSitterTypesVersion: string;
  readonly standardLibraries: Readonly<Record<string, string>>;
  readonly externalDeclarations: Readonly<Record<string, string>>;
};
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Use only declaration bytes embedded by the release build and named by the verified installed manifest. */
export async function verifiedStandaloneTypeEnvironment(releaseRoot: string, manifestSha256: string): Promise<TypeEnvironment> {
  const manifestBytes = readFileSync(join(releaseRoot, "share", "typescript", "type-environment.json"));
  if (sha256(manifestBytes) !== manifestSha256) throw new Error("installed TypeScript declaration manifest changed after release verification; reinstall Bounded");
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (!record(manifest) || manifest.schema !== "bounded-type-environment/1" || manifest.typescriptVersion !== "5.9.3"
    || manifest.nodeTypesVersion !== "26.6.4" || manifest.undiciTypesVersion !== "8.9.0"
    || manifest.treeSitterTypesVersion !== "0.3.1" || !record(manifest.standardLibraries) || !record(manifest.externalDeclarations))
    throw new Error("installed TypeScript declaration manifest is malformed; reinstall Bounded");
  const asset = Bun.embeddedFiles.find((file) => /^bounded-type-environment-bytes(?:-[a-z0-9]+)?\.bin$/.test(String(Reflect.get(file, "name"))));
  if (asset === undefined) throw new Error("standalone executable lacks its bundled TypeScript declarations; reinstall Bounded");
  const embedded: unknown = JSON.parse(await asset.text());
  if (!record(embedded) || !record(embedded.standardLibraries) || !record(embedded.externalDeclarations))
    throw new Error("bundled TypeScript declarations are malformed; reinstall Bounded");
  const decode = (expected: Record<string, unknown>, supplied: Record<string, unknown>, area: string): Record<string, Uint8Array> => {
    const expectedNames = Object.keys(expected).sort();
    if (expectedNames.join("\0") !== Object.keys(supplied).sort().join("\0"))
      throw new Error(`bundled ${area} declaration set differs from the installed manifest; reinstall Bounded`);
    const result: Record<string, Uint8Array> = {};
    for (const path of expectedNames) {
      const hash = expected[path];
      const encoded = supplied[path];
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || typeof encoded !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        throw new Error(`bundled ${area} declaration ${path} is malformed; reinstall Bounded`);
      const bytes = Buffer.from(encoded, "base64");
      if (sha256(bytes) !== hash) throw new Error(`bundled ${area} declaration ${path} fails SHA-256 verification; reinstall Bounded`);
      result[path] = bytes;
    }
    return result;
  };
  const typed = manifest as Manifest;
  return {
    standardLibraries: decode(typed.standardLibraries, embedded.standardLibraries, "TypeScript library"),
    externalDeclarations: decode(typed.externalDeclarations, embedded.externalDeclarations, "external type"),
  };
}
