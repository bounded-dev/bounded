import type { ProjectConfigSource } from "bounded/application";
import { Config, type Result } from "bounded/domain";

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

/**
 * Any configuration source, its answers checked: a source a host provides
 * may throw, or answer in a form other than a result, so this is the
 * boundary where its answer is parsed. What it loads must be a
 * configuration made by defineConfig. Never rejects.
 */
export class CheckedProjectConfigSource implements ProjectConfigSource {
  constructor(private readonly source: ProjectConfigSource) {}

  async load(projectRoot: string): Promise<Result<Config>> {
    let loaded: unknown;
    try {
      loaded = await this.source.load(projectRoot);
    } catch (thrown) {
      return { ok: false, error: `the configuration source failed: ${text(thrown)}` };
    }
    if (typeof loaded !== "object" || loaded === null || !("ok" in loaded)) return { ok: false, error: "the configuration source returned no result" };
    if (loaded.ok !== true) return { ok: false, error: "error" in loaded && typeof loaded.error === "string" ? loaded.error : "the configuration source returned no reason" };
    return Config.parse("value" in loaded ? loaded.value : undefined);
  }
}
