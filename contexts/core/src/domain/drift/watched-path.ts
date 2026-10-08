import { own, readSafely } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire } from "../shared/wire.ts";
import type * as Contract from "./watched-path.contract.ts";

const SAYS = "A watched path says why its files are watched and what to do instead: why and redirect are non-empty text";

/** Why a glob is not a project-relative one, or undefined. */
function globProblem(raw: unknown): string | undefined {
  const glob = typeof raw === "string" ? raw : String(raw);
  const relative = typeof raw === "string" && raw !== "" && !raw.startsWith("/") && !raw.includes("\\") && !raw.split("/").includes("..");
  return relative ? undefined : `Watched path pattern '${glob}' must be a project-relative glob: not empty, no leading '/', no '..', no '\\'`;
}

const text = (raw: unknown): raw is string => typeof raw === "string" && raw.trim() !== "";

class WatchedPathImpl implements Contract.WatchedPath {
  declare readonly __brand: "WatchedPath";
  readonly #made = true;

  private constructor(
    readonly match: string,
    readonly except: readonly string[],
    readonly why: string,
    readonly redirect: string,
  ) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse trusts it as it is. */
  static made(raw: unknown): raw is WatchedPathImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<WatchedPath> {
    return readSafely("A watched path", () => WatchedPathImpl.check(raw));
  }

  private static check(raw: unknown): Result<WatchedPath> {
    if (WatchedPathImpl.made(raw)) return { ok: true, value: raw };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "A watched path is { match, except?, why, redirect }" };
    const [match, except, why, redirect] = [own(raw, "match"), own(raw, "except") ?? [], own(raw, "why"), own(raw, "redirect")];
    if (!text(why) || !text(redirect)) return { ok: false, error: SAYS };
    const matchProblem = globProblem(match);
    if (matchProblem !== undefined) return { ok: false, error: matchProblem };
    if (!Array.isArray(except)) return { ok: false, error: "A watched path's except is a list of project-relative globs" };
    for (const glob of except) {
      const problem = globProblem(glob);
      if (problem !== undefined) return { ok: false, error: problem };
    }
    return { ok: true, value: new WatchedPathImpl(String(match), Object.freeze(except.map(String)), why.trim(), redirect.trim()) };
  }

  equals(other: WatchedPath): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.WatchedPathJSON {
    return { match: this.match, except: this.except, why: this.why, redirect: this.redirect };
  }
}

export type WatchedPath = Contract.WatchedPath;
export const WatchedPath: Contract.WatchedPathFactory = WatchedPathImpl;
