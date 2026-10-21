import type { PackageCatalog } from "bounded/domain";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManagedPackRuntimeGraph } from "./managed-pack-installer.ts";

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
type Entry = { readonly package: PackageCatalog["package"]; readonly pack: PackageCatalog["packs"][number] };

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Find the nearest project's state boundary, including a malformed one that must refuse. */
export function standalonePackDiscoveryProjectRoot(cwd: string): string {
  let directory = cwd;
  while (true) {
    try {
      const boundary = lstatSync(join(directory, ".bounded"));
      if (!boundary.isDirectory() || boundary.isSymbolicLink())
        throw new Error(`${join(directory, ".bounded")} is linked or not a directory`);
      return directory;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return cwd;
    directory = parent;
  }
}

/** Recheck mutable project state after capture and rendering, immediately before output. */
export async function verifyStandalonePackDiscoveryBoundary(
  projectRoot: string,
  graph?: Pick<ManagedPackRuntimeGraph, "recheckBoundary">,
): Promise<Result<void>> {
  if (graph !== undefined) {
    const verifiedGraph = await graph.recheckBoundary();
    if (!verifiedGraph.ok) return verifiedGraph;
  }
  const journal = join(projectRoot, ".bounded", "update-journal.json");
  try {
    lstatSync(journal);
    return { ok: false, error: `project update journal ${journal} requires recovery before pack discovery` };
  } catch (error) {
    if (!isMissing(error)) return { ok: false, error: `cannot inspect project update journal ${journal}: ${String(error)}` };
  }
  return { ok: true, value: undefined };
}

/** Format only catalogue snapshots whose release and managed bytes the caller has verified. */
export function renderStandalonePackDiscovery(
  includedCatalogue: PackageCatalog,
  graph: ManagedPackRuntimeGraph | undefined,
  selectedPackId?: string,
): Result<string> {
  const entries = new Map<string, Entry>();
  const catalogues: PackageCatalog[] = [includedCatalogue];
  if (graph !== undefined) {
    for (const node of Object.values(graph.nodes)) {
      if (node.catalogue !== null) catalogues.push(node.catalogue);
    }
  }
  for (const catalogue of catalogues) {
    for (const pack of catalogue.packs) {
      if (entries.has(pack.id)) return { ok: false, error: `Pack ${pack.id} appears in more than one included catalogue; repair the installed pack graph` };
      entries.set(pack.id, { package: catalogue.package, pack });
    }
  }
  if (selectedPackId !== undefined) {
    const selected = entries.get(selectedPackId);
    if (selected === undefined) return { ok: false, error: `Pack ${selectedPackId} is not included in this Bounded release or the project's managed pack graph` };
    return { ok: true, value: `${JSON.stringify(selected, null, 2)}\n` };
  }
  const hasControlCharacters = (value: string): boolean => [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || (codePoint >= 127 && codePoint <= 159)
      || codePoint === 0x2028 || codePoint === 0x2029);
  });
  for (const { package: owner, pack } of entries.values()) {
    for (const [field, value] of [["pack id", pack.id], ["package name", owner.name],
      ["package version", owner.version], ["pack summary", pack.summary]] as const) {
      if (hasControlCharacters(value))
        return { ok: false, error: `Pack ${JSON.stringify(pack.id)} catalogue ${field} contains control characters unsafe for one-line listing; rebuild the pack catalogue` };
    }
  }
  const listed = [...entries.values()].sort((left, right) => left.pack.id < right.pack.id ? -1 : left.pack.id > right.pack.id ? 1 : 0);
  return { ok: true, value: listed.map(({ package: owner, pack }) => `${pack.id}\t${owner.name}@${owner.version}\t${pack.summary}\n`).join("") };
}
