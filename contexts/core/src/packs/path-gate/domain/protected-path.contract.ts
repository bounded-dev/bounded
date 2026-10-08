import type { Result } from "bounded/domain";

/** The brand only ProtectedPath itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const protectedPathBrand: unique symbol;

/** What a rule can deny on a path: reading it, listing it, or one kind of write. */
export type PathAccess = "read" | "list" | "create" | "modify" | "delete";

/**
 * A protected-path rule: deny-only. It denies `deny` on every project path
 * its `match` glob matches, except the paths its own `except` globs match.
 * A match ending in a literal name also covers everything under that name,
 * unless `file` is true: then it names files only, and covers exactly them.
 * An exception never reaches another rule, and there are no allow rules, so
 * a denial from any rule wins. `redirect` is the permitted next step.
 */
export interface ProtectedPath {
  readonly __brand: "ProtectedPath";
  readonly [protectedPathBrand]: true;
  readonly match: string;
  readonly except: readonly string[];
  readonly deny: readonly [PathAccess, ...PathAccess[]];
  readonly redirect: string;
  readonly why?: string;
  /** True when the match names files only, not what is under them; absent otherwise. */
  readonly file?: true;
  /** Whether the rule applies to this exact path: its match covers it (ignoring case) and none of its exceptions does (exactly). */
  matches(path: string): boolean;
  /**
   * Whether listing or searching `root`, limited by a file-name `filter` (or
   * none), could reach a path the rule applies to. Conservative: no only
   * when that is provable.
   */
  reaches(root: string, filter: string | null): boolean;
  /** Whether deleting `path`, were it a directory, could delete a path the rule applies to. */
  contains(path: string): boolean;
  /** Whether no root or filter can keep a listing away from the rule: '**'-led, ending in a name that is not a file rule's. */
  unavoidable(): boolean;
  /** Whether a file-name filter can ever keep a listing away from the rule: its last part names the files themselves. */
  filterable(): boolean;
  equals(other: ProtectedPath): boolean;
  toJSON(): ProtectedPathJSON;
}

/**
 * A rule's wire form: what packs and projects write (an object literal) and
 * ProtectedPath.parse takes, and what toJSON gives back, stored explicitly.
 */
export interface ProtectedPathJSON {
  readonly match: string;
  readonly except?: readonly string[];
  readonly deny: readonly [PathAccess, ...PathAccess[]];
  readonly redirect: string;
  readonly why?: string;
  readonly file?: boolean;
}

export interface ProtectedPathFactory {
  /**
   * A frozen rule, stored explicitly: patterns tidied (NFC, no './', no empty
   * parts), deny in a fixed order without repeats, except always present. Or
   * why the value is not a rule. Patterns are project-relative globs that
   * picomatch compiles: never absolute, with '..', negated, parenthesised or
   * a trailing '/', and at most 512 characters.
   */
  parse(raw: unknown): Result<ProtectedPath>;
}
