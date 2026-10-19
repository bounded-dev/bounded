import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export interface TarEntry {
  readonly name: string;
  readonly body?: Uint8Array | string;
  readonly type?: "file" | "directory" | "symlink" | "hardlink";
  readonly linkName?: string;
}

const put = (block: Uint8Array, offset: number, length: number, value: string): void => {
  block.set(new TextEncoder().encode(value).subarray(0, length), offset);
};

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, "0")}\0`;

/** Minimal ustar writer for adversarial archive fixtures; the installer must parse these bytes itself. */
export function tarball(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const body = typeof entry.body === "string" ? new TextEncoder().encode(entry.body) : (entry.body ?? new Uint8Array());
    const header = new Uint8Array(512);
    put(header, 0, 100, entry.name);
    put(header, 100, 8, octal(0o644, 8));
    put(header, 108, 8, octal(0, 8));
    put(header, 116, 8, octal(0, 8));
    put(header, 124, 12, octal(body.length, 12));
    put(header, 136, 12, octal(0, 12));
    header.fill(32, 148, 156);
    put(header, 156, 1, { file: "0", directory: "5", symlink: "2", hardlink: "1" }[entry.type ?? "file"]);
    put(header, 157, 100, entry.linkName ?? "");
    put(header, 257, 6, "ustar\0");
    put(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    put(header, 148, 8, octal(checksum, 8));
    blocks.push(header, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((size, block) => size + block.length, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
}

export const packageArchive = (entries: readonly TarEntry[]): Uint8Array => gzipSync(tarball(entries));

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const sha512Integrity = (bytes: Uint8Array): string => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export const catalogue = (name = "bounded-example", version = "1.0.0") => ({
  catalogVersion: 1,
  package: { name, version },
  packs: [{
    id: `${name}/refused-tools`, importPath: name, exportName: "refusedToolsPack",
    summary: "Refuses selected tools", documentation: "A published pack for the installer contract.",
    dependsOn: ["bounded/core"], contributesTo: ["bounded/core.beforeTool"], points: [], ports: [],
    readme: {
      path: "packs/refused-tools/README.md", introduction: "A test pack.", whatItIsFor: "Refusing selected tools.",
      ruleShape: "List tools.", workflowsItFits: "Any.", whatItObserves: "Tool names.",
      whatItCannotSee: "Other tool calls.", ports: "None.", examples: "One example.", otherSections: [],
    },
    examples: [{ path: "packs/refused-tools/examples/basic.config.ts", title: "A refusal", description: "Refuses one tool.",
      source: "export default 1;\n", scenarios: [{ title: "A tool is refused", projectFiles: {},
        steps: [{ toolUse: { role: null, tool: "blocked", effects: [{ kind: "read", path: "README.md" }] }, verdict: { kind: "deny", reason: "blocked" } }] }] }],
  }],
});

export const manifest = (name = "bounded-example", version = "1.0.0") => ({
  name, version, type: "module",
  exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
  bounded: { catalog: "./bounded.catalog.json", packs: { ".": "packs/refused-tools" } },
  peerDependencies: { bounded: "~3.3.0" },
});

export const packageEntries = (packageManifest: Record<string, unknown> = manifest(), packageCatalogue: Record<string, unknown> = catalogue()): TarEntry[] => [
  { name: "package/package.json", body: `${JSON.stringify(packageManifest)}\n` },
  { name: "package/bounded.catalog.json", body: `${JSON.stringify(packageCatalogue)}\n` },
  { name: "package/dist/index.js", body: "export const refusedToolsPack = {};\n" },
  { name: "package/dist/index.d.ts", body: "export declare const refusedToolsPack: unknown;\n" },
];
