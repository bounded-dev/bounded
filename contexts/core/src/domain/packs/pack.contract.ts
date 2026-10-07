import type { ExtensionPointHandle } from "../extension-points/extension-point.contract.ts";
import type { Contribution } from "./contribution.contract.ts";
import type { OneLiteral } from "./one-literal.contract.ts";

/** A pack as composition sees it: a name, its dependencies, what it declares and contributes. */
export interface Pack {
  readonly __brand: "Pack";
  readonly name: string;
  readonly dependsOn: readonly string[];
  readonly declares: readonly ExtensionPointHandle<string>[];
  readonly contributes: readonly Contribution<string>[];
}

/**
 * The typed door in. `Name` and `Dependencies` are inferred from `name` and
 * the `dependsOn` tuple alone (`NoInfer` stops a contribution from widening
 * them); then every declaration must be owned by `Name` and every
 * contribution must target `Name` or one of the `Dependencies`.
 */
export interface PackSpec<Name extends string, Dependencies extends readonly string[]> {
  readonly name: Name;
  readonly dependsOn?: Dependencies;
  readonly declares?: readonly ExtensionPointHandle<NoInfer<Name>>[];
  readonly contributes?: readonly Contribution<NoInfer<Name | Dependencies[number]>>[];
}

/** Every name is one literal, and `dependsOn` is written whenever there are dependencies. */
export type CheckedNames<Name extends string, Dependencies extends readonly string[]> = { readonly name: OneLiteral<Name> } & (Dependencies extends readonly []
  ? unknown
  : { readonly dependsOn: { readonly [K in keyof Dependencies]: OneLiteral<Extract<Dependencies[K], string>> } });

export interface PackFactory {
  new <const Name extends string, const Dependencies extends readonly string[] = []>(
    spec: PackSpec<Name, Dependencies> & CheckedNames<Name, Dependencies>,
  ): Pack;
  /** Whether `x` was made by `new Pack`: composition accepts no other. */
  isPack(x: unknown): x is Pack;
}
