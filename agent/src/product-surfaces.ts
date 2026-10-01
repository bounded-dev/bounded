// Product surfaces: the places a product is used from, in the user's terms
// (ADR 2026-065). `bounded init` reads the product spec first; the agent maps
// it to these surfaces and init turns the decisions into a pack selection.
//
// The core owns the vocabulary, because init's validation consumes it, and
// names no technology: which pack serves a surface is pack data, each pack's
// `productSurfaces` in its contrib.json.

export interface ProductSurface {
  readonly id: string;
  /** What the surface is, in the user's terms. */
  readonly label: string;
  /** What to ask when the spec leaves the surface open. */
  readonly question: string;
}

export const PRODUCT_SURFACES: readonly ProductSurface[] = Object.freeze([
  { id: "browser-ui", label: "an app people use in a web browser",
    question: "Will people use it in a web browser?" },
  { id: "desktop", label: "an installable desktop app",
    question: "Do people need an installable desktop app?" },
  { id: "assistant-tools", label: "tools AI assistants can call",
    question: "Should AI assistants, such as Claude, be able to use it as tools?" },
  { id: "scheduled-jobs", label: "jobs that run on their own on a timer",
    question: "Does anything need to run on its own on a schedule, such as a nightly export?" },
  { id: "network-api", label: "an API other programs call over the network",
    question: "Do other programs need to call it over the network?" },
  { id: "persistence", label: "data kept safely across restarts",
    question: "Does it need to keep data, so nothing is lost when it restarts?" },
]);

const SURFACE_IDS: ReadonlySet<string> = new Set(PRODUCT_SURFACES.map((surface) => surface.id));

export function isProductSurface(id: string): boolean {
  return SURFACE_IDS.has(id);
}

/** What the agent took from the spec and the user's answers. */
export interface SurfaceDecisions {
  /** Surfaces the product needs. */
  readonly needed: readonly string[];
  /** Surfaces the product does not need. */
  readonly declined: readonly string[];
}

/** The pack data the selection reads: what each installed pack serves and needs. */
export interface SurfacePack {
  readonly dependsOnPacks: readonly string[];
  readonly productSurfaces: readonly string[];
}

export type SurfaceState = "needed" | "declined" | "included" | "open";

export interface SurfaceReport {
  readonly id: string;
  readonly state: SurfaceState;
  /** The packs in the selection that serve it. */
  readonly servedBy: readonly string[];
  readonly question?: string;
}

export type SurfaceSelection =
  | { readonly kind: "selected"; readonly packs: readonly string[]; readonly surfaces: readonly SurfaceReport[] }
  | { readonly kind: "open"; readonly surfaces: readonly SurfaceReport[]; readonly questions: readonly ProductSurface[] }
  | { readonly kind: "refused"; readonly reason: string };

/** The surfaces some installed pack serves: the only ones init can deliver. */
export function offeredSurfaces(available: ReadonlyMap<string, SurfacePack>): ProductSurface[] {
  const served = new Set([...available.values()].flatMap((pack) => pack.productSurfaces));
  return PRODUCT_SURFACES.filter((surface) => served.has(surface.id));
}

/**
 * Turn surface decisions into a pack selection. Each needed surface must be
 * served by exactly one installed pack (an explicit pack breaks a tie); the
 * selection is that set plus `explicitPacks`, closed under dependencies by
 * `close`. A surface the closure already serves counts as decided. Any
 * offered surface still undecided makes the result `open`, carrying the
 * question for each, so init never guesses what the spec left open.
 */
export function selectForSurfaces(
  decisions: SurfaceDecisions,
  available: ReadonlyMap<string, SurfacePack>,
  close: (names: readonly string[]) => readonly string[],
  explicitPacks: readonly string[] = [],
): SurfaceSelection {
  for (const id of [...decisions.needed, ...decisions.declined]) {
    if (!isProductSurface(id)) {
      return { kind: "refused", reason: `Unknown product surface '${id}'; choose from ${PRODUCT_SURFACES.map((s) => s.id).join(", ")}` };
    }
  }
  const both = decisions.needed.find((id) => decisions.declined.includes(id));
  if (both !== undefined) return { kind: "refused", reason: `Product surface '${both}' is both needed and declined` };
  for (const [name, pack] of available) {
    const unknown = pack.productSurfaces.find((id) => !isProductSurface(id));
    if (unknown !== undefined) return { kind: "refused", reason: `Capability '${name}' declares unknown product surface '${unknown}'` };
  }
  const servers = (id: string): string[] =>
    [...available].filter(([, pack]) => pack.productSurfaces.includes(id)).map(([name]) => name);
  const chosen = [...explicitPacks];
  for (const id of decisions.needed) {
    const candidates = servers(id);
    if (candidates.some((name) => chosen.includes(name))) continue;
    const label = PRODUCT_SURFACES.find((s) => s.id === id)!.label;
    if (candidates.length === 0) {
      return { kind: "refused", reason: `No installed capability provides ${label} (${id}); the product needs it, so initialization stops here` };
    }
    if (candidates.length > 1) {
      return { kind: "refused", reason: `Several installed capabilities provide ${label} (${id}): ${candidates.join(", ")}; add --pack to choose one` };
    }
    chosen.push(candidates[0]!);
  }
  const packs = chosen.length > 0 ? close(chosen) : [];
  const surfaces: SurfaceReport[] = offeredSurfaces(available).map((surface) => {
    const servedBy = packs.filter((name) => available.get(name)?.productSurfaces.includes(surface.id));
    const state: SurfaceState = decisions.needed.includes(surface.id) ? "needed"
      : servedBy.length > 0 ? "included"
      : decisions.declined.includes(surface.id) ? "declined"
      : "open";
    return { id: surface.id, state, servedBy, ...(state === "open" ? { question: surface.question } : {}) };
  });
  const open = surfaces.filter((surface) => surface.state === "open").map((surface) => PRODUCT_SURFACES.find((s) => s.id === surface.id)!);
  if (open.length > 0) return { kind: "open", surfaces, questions: open };
  if (packs.length === 0) return { kind: "refused", reason: "The decisions select no capability: the product needs at least one surface" };
  return { kind: "selected", packs, surfaces };
}
