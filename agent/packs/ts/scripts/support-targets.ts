// Containment for contract support files (ADR 2026-046).
//
// A support file's targets come from a contributed function reading the
// contract's own import specifiers, so a contract can point one anywhere:
// `../../../x/service-runtime.js` from a shallow contract resolves outside the
// project. The consumers (the scaffolder in the live tree, the red gate in its
// shadow project) write only targets under the project's source roots (`src/`
// by default; the monorepo passes its sourceRoots, ADR 2026-056), and refuse
// the rest with the exact path and the reason.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ContractSupportFile } from "../pack.ts";
import { sourceRootOf } from "../../../src/pack-contrib.ts";

export type SupportTargets =
  | { readonly ok: true; readonly targets: readonly string[] }
  | { readonly ok: false; readonly reason: string };

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The nearest ancestor of `path` (itself included) that exists as a directory
 * entry, links resolved; undefined when that entry is a link that cannot be
 * resolved (dangling, or a loop), because writing through it would land
 * wherever it points. `lstat` rather than `exists`: a dangling link does not
 * "exist", and walking past it would judge its parent instead.
 */
function realAncestor(path: string): string | undefined {
  let current = path;
  for (;;) {
    try {
      lstatSync(current);
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
  try {
    return realpathSync(current);
  } catch {
    return undefined;
  }
}

/**
 * The absolute targets `support` asks for from this contract, each checked to
 * lie strictly inside `<projectRoot>/src` both as written and after resolving
 * the links of its nearest existing entry (a dangling link is refused). Any
 * escape refuses the whole contract's support: nothing is written.
 */
export function containedSupportTargets(
  support: ContractSupportFile,
  contractSource: string,
  contractPath: string,
  projectRoot: string,
  sourceRoots: readonly string[] = ["src"],
): SupportTargets {
  const contract = resolve(projectRoot, contractPath);
  const contractRel = relative(projectRoot, contract).split(sep).join("/");
  const where = sourceRoots.map((r) => `${r}/`).join(", ");
  const targets: string[] = [];
  for (const raw of support.targets(contractSource, contract)) {
    const target = resolve(projectRoot, raw);
    const shown = relative(projectRoot, target).split(sep).join("/");
    // The concrete root the target lies under, by its written path; then the
    // same containment asked of its nearest existing entry, links resolved.
    const concrete = isAbsolute(shown) || shown.startsWith("..") ? undefined : sourceRootOf(shown, sourceRoots);
    const src = concrete === undefined ? undefined : resolve(projectRoot, concrete);
    const escapes = src === undefined || !inside(src, target) || (() => {
      const realSrc = existsSync(src) ? realpathSync(src) : src;
      const ancestor = realAncestor(target);
      return ancestor === undefined || (ancestor !== realSrc && !inside(realSrc, ancestor));
    })();
    if (escapes) {
      return {
        ok: false,
        reason: `${contractRel} asks for the ${support.label} at '${shown}', which resolves outside the project's ${where} — ` +
          `a support file is written only under ${where}; point the contract's import at a path inside ${where}`,
      };
    }
    targets.push(target);
  }
  return { ok: true, targets };
}
