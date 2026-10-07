import type { AnyPack, Composition, PackId, Result } from "bounded/domain";

// Wire input: what callers send.
export interface ComposePacksInput {
  readonly selected: readonly string[];
}

// Command: the input once validated into value objects.
export interface ComposePacksCommand {
  readonly __brand: "ComposePacksCommand";
  readonly selected: readonly PackId[];
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
/** The packs available to compose from. */
export interface ComposePacksCatalog {
  available(): Promise<readonly AnyPack[]>;
}
