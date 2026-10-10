import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DecisionTime } from "bounded/domain";
import type { PrerequisiteStatusSnapshot, PrerequisiteStatusSnapshotFileJSON, PrerequisiteStatusSnapshots } from "../../../application/check-prerequisites/check-prerequisites.contract.ts";

/** How old a temporary file must be before a save sweeps it away: one a save cut short left behind. */
const TEMPORARY_MAX_AGE_MS = 60 * 1000;
/** A temporary file a save writes before renaming it into place. */
const TEMPORARY = /^status\.json\..+\.tmp$/;

/** When the kept snapshot's reading began, or undefined when none is kept or it cannot be read. */
async function keptReadingStartedAt(file: string): Promise<number | undefined> {
  try {
    const kept: unknown = JSON.parse(await readFile(file, "utf8"));
    const startedAt = typeof kept === "object" && kept !== null && "readingStartedAt" in kept ? DecisionTime.parse(kept.readingStartedAt) : undefined;
    return startedAt?.ok ? Date.parse(startedAt.value.value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The status snapshot of bounded/prereqs in the project, as
 * `.bounded/prereqs/status.json` beside the pack's records (ADR 2026-026),
 * in its file form: the snapshot and the project's root. Each save writes a
 * temporary file and renames it into place, so a reader sees a whole file or
 * none. An older reading never replaces a newer one: the kept file's
 * readingStartedAt is compared first, best effort under hooks running in
 * processes of their own, so the file may be one call behind. Temporary
 * files older than a minute are swept away on save. A save that fails
 * removes status.json, then rejects: a display shows nothing rather than an
 * old status. The file decides nothing, so anything that can write it can
 * only mislead a display.
 */
export class FileSystemPrerequisiteStatusSnapshots implements PrerequisiteStatusSnapshots {
  private readonly dir: string;
  private readonly file: string;
  private readonly temporaryNameOf: (dir: string) => string;

  /** `temporaryNameOf` names each save's temporary file in the snapshot's directory; tests inject it. */
  constructor(
    private readonly projectRoot: string,
    options: { readonly temporaryNameOf?: (dir: string) => string } = {},
  ) {
    this.dir = join(projectRoot, ".bounded", "prereqs");
    this.file = join(this.dir, "status.json");
    this.temporaryNameOf = options.temporaryNameOf ?? ((dir) => join(dir, `status.json.${randomUUID()}.tmp`));
  }

  now(): unknown {
    return new Date().toISOString();
  }

  async save(snapshot: PrerequisiteStatusSnapshot): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await this.sweep();
      const kept = await keptReadingStartedAt(this.file);
      if (kept !== undefined && kept > Date.parse(snapshot.readingStartedAt.value)) return;
      const form: PrerequisiteStatusSnapshotFileJSON = { ...snapshot.toJSON(), projectRoot: this.projectRoot };
      const temporary = this.temporaryNameOf(this.dir);
      await writeFile(temporary, `${JSON.stringify(form)}\n`);
      await rename(temporary, this.file);
    } catch (thrown) {
      await rm(this.file, { force: true }).catch(() => undefined);
      throw thrown;
    }
  }

  /** Removes temporary files older than a minute: saves cut short left them. */
  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const name of await readdir(this.dir)) {
      if (!TEMPORARY.test(name)) continue;
      const path = join(this.dir, name);
      try {
        if (now - (await stat(path)).mtimeMs > TEMPORARY_MAX_AGE_MS) await rm(path, { force: true });
      } catch {
        // Gone already, or swept by another save.
      }
    }
  }
}
