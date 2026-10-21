import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const missing = (error: unknown): boolean => record(error) && error.code === "ENOENT";
const exists = (path: string): boolean => {
  try { lstatSync(path); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
};
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function safeDirectory(path: string): void {
  const details = lstatSync(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${path} is linked or not a directory`);
}

/** One update owner, acquired before the managed-pack writer. A dead owner is reclaimed under a second exclusive directory. */
export async function acquireStandaloneUpdateWriter(projectRoot: string): Promise<Result<() => void>> {
  const boundary = join(projectRoot, ".bounded");
  const writer = join(boundary, ".update-writer");
  const reclaim = join(boundary, ".update-reclaim");
  try {
    safeDirectory(projectRoot);
    if (!exists(boundary)) mkdirSync(boundary);
    safeDirectory(boundary);
  } catch (error) { return { ok: false, error: `Cannot prepare project update writer: ${errorText(error)}` }; }
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      mkdirSync(writer);
      const nonce = randomUUID();
      try { writeFileSync(join(writer, "owner.json"), `${JSON.stringify({ pid: process.pid, nonce })}\n`, { flag: "wx" }); }
      catch (error) { rmSync(writer, { recursive: true, force: true }); throw error; }
      return { ok: true, value: () => {
        safeDirectory(writer);
        const owner: unknown = JSON.parse(readFileSync(join(writer, "owner.json"), "utf8"));
        if (!record(owner) || owner.pid !== process.pid || owner.nonce !== nonce)
          throw new Error(`Project update writer ownership changed at ${writer}`);
        rmSync(writer, { recursive: true });
      } };
    } catch (error) {
      if (!record(error) || error.code !== "EEXIST")
        return { ok: false, error: `Cannot acquire project update writer: ${errorText(error)}` };
      try {
        safeDirectory(writer);
        mkdirSync(reclaim);
      } catch (guardError) {
        if (!record(guardError) || guardError.code !== "EEXIST")
          return { ok: false, error: `Cannot inspect project update writer: ${errorText(guardError)}` };
        await Bun.sleep(50);
        continue;
      }
      try {
        if (!exists(writer)) continue;
        let names = readdirSync(writer);
        for (let ownerWait = 0; names.length === 0 && ownerWait < 20; ownerWait++) {
          await Bun.sleep(50);
          if (!exists(writer)) break;
          names = readdirSync(writer);
        }
        if (!exists(writer)) continue;
        if (names.length !== 1 || names[0] !== "owner.json")
          return { ok: false, error: `Project update writer ownership is uncertain at ${writer}; repair manually` };
        const owner: unknown = JSON.parse(readFileSync(join(writer, "owner.json"), "utf8"));
        if (!record(owner) || !Number.isSafeInteger(owner.pid) || typeof owner.nonce !== "string"
          || !/^[a-f0-9-]{36}$/.test(owner.nonce))
          return { ok: false, error: `Project update writer ownership is uncertain at ${writer}; repair manually` };
        try { process.kill(owner.pid as number, 0); }
        catch (probeError) {
          if (!record(probeError) || probeError.code !== "ESRCH")
            return { ok: false, error: `Cannot prove project update writer has exited: ${errorText(probeError)}` };
          rmSync(writer, { recursive: true });
        }
      } catch (inspectError) {
        return { ok: false, error: `Cannot inspect project update writer: ${errorText(inspectError)}` };
      } finally { rmSync(reclaim, { recursive: true, force: true }); }
      await Bun.sleep(50);
    }
  }
  return { ok: false, error: `Project update writer is busy at ${writer}; retry the update` };
}
