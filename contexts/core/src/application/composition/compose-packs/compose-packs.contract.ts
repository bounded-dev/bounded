import type { AvailablePacks, Composition, PackId, Result } from "bounded/domain";

/** The brand only ComposePacksCommand itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const composePacksCommandBrand: unique symbol;

// Wire input: what callers send.
export interface ComposePacksInput {
  readonly selectedPackIds: readonly string[];
}

// Command: the input once validated into value objects.
export interface ComposePacksCommand {
  readonly __brand: "ComposePacksCommand";
  readonly [composePacksCommandBrand]: true;
  readonly selectedPackIds: readonly PackId[];
}

export interface ComposePacksCommandFactory {
  parse(raw: unknown): Result<ComposePacksCommand>;
}

// In port: what this feature offers.
/** Compose a project's selected packs into the extension points they fill. */
export interface ComposePacks {
  execute(command: ComposePacksCommand): Promise<Result<Composition>>;
}

// Out port: exactly what this feature needs.
/**
 * The packs available to compose from, parsed (each made by definePack, each id its own), or why they cannot be.
 * @implementedBy InMemoryComposePacksCatalog
 */
export interface ComposePacksCatalog {
  available(): Promise<Result<AvailablePacks>>;
}
