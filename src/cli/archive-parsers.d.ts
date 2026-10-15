declare module "tar-stream" {
  import type { Readable, Writable } from "node:stream";
  interface Pack extends Readable {
    entry(header: { name: string; size: number; mode: number; type: "file" }, body: Buffer): void;
    finalize(): void;
  }
  interface Entry extends Readable {
    readonly header: { readonly name: string; readonly type: string; readonly size: number };
  }
  interface Extract extends Writable, AsyncIterable<Entry> {}
  const tar: { extract(): Extract; pack(): Pack };
  export default tar;
}

declare module "yauzl" {
  import type { Readable } from "node:stream";
  interface Entry {
    readonly fileName: string;
    readonly uncompressedSize: number;
    readonly externalFileAttributes: number;
    readonly versionMadeBy: number;
  }
  interface ZipFile {
    eachEntry(): AsyncIterable<Entry>;
    openReadStreamPromise(entry: Entry): Promise<Readable>;
    close(): void;
  }
  const yauzl: { fromBufferPromise(buffer: Buffer, options?: { strictFileNames?: boolean; validateEntrySizes?: boolean }): Promise<ZipFile> };
  export default yauzl;
}
