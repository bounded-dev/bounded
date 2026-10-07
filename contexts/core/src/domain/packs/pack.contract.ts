import type { ExtensionPointHandle } from "../extension-points/extension-point.contract.ts";
import type { Contribution } from "./contribution.contract.ts";

/** A pack as composition sees it: a name, its dependencies, what it declares and contributes. */
export interface Pack {
  readonly __brand: "Pack";
  readonly name: string;
  readonly dependsOn: readonly string[];
  readonly declares: readonly ExtensionPointHandle<string>[];
  readonly contributes: readonly Contribution<string>[];
}

/**
 * The typed door in. `NoInfer` stops the compiler from widening `Name` or
 * `Dependency` to fit a contribution: they are inferred from `name` and
 * `dependsOn` alone, and then every declaration must be owned by `Name` and
 * every contribution must target `Name` or a `Dependency`.
 */
export interface PackSpec<Name extends string, Dependency extends string> {
  readonly name: Name;
  readonly dependsOn?: readonly Dependency[];
  readonly declares?: readonly ExtensionPointHandle<NoInfer<Name>>[];
  readonly contributes?: readonly Contribution<NoInfer<Name | Dependency>>[];
}

/** A name or dependency widened to `string` would switch the check off, so it does not compile. */
export type LiteralNames<Name extends string, Dependency extends string> = (string extends Name ? { readonly name: never } : unknown) &
  (string extends Dependency ? { readonly dependsOn: never } : unknown);

export interface PackFactory {
  new <const Name extends string, const Dependency extends string = never>(
    spec: PackSpec<Name, Dependency> & LiteralNames<Name, Dependency>,
  ): Pack;
}
