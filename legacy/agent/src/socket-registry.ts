// The typed socket registry (TN-26-005, "the socket layer's implementation
// shape"): the core owns MECHANISMS, packs own CONTENT.
//
// `pack-contrib.ts` beside this file is the DATA-ONLY half of the same idea —
// a pack's `contrib.json`, readable without executing pack code, which is what
// intake nouns and component return-type names need. This file is the
// CODE-BEARING half: contributions that are functions and objects (an ESLint
// rule, a flat-config block) cannot be JSON, so they ride a registry instead.
// Both halves obey the same law — nothing here names a technology. There is no
// word in this module for ESLint, React, tRPC or TypeScript, and there must
// never be one: the ts pack DEFINES an "extra lint rules" socket, ts-web
// CONTRIBUTES to it, and the core only knows that a pack declared a socket and
// another pack filled it (TN-26-005, "two-level sockets").
//
// WHAT A SOCKET IS. A named extension point with:
//   · a VALUE TYPE, carried as a phantom type — a contribution of the wrong
//     shape does not compile;
//   · an OWNING PACK, carried as a phantom type too — this is the load-bearing
//     one. Contributing to a socket owned by a pack you did not declare in
//     `dependsOnPacks` is a COMPILE error (the owner name is not in your
//     declared set) AND a runtime refusal that names the missing edge. "No pack
//     depends on another implicitly" is the rule the whole note exists to
//     protect, and a rule enforced only by prose is a rule that holds until the
//     first hurried afternoon;
//   · a description, so a socket's purpose is legible where it is declared;
//   · an optional `validate` hook, run over every contributed value at
//     composition time, so a malformed contribution is refused at the seam
//     rather than three layers downstream in the consumer.
//
// WHY COMPOSITION TAKES A PACK LIST. At project initiation the harness is
// composed into the simplest form a project needs, and most installed packs
// stay uncomposed (TN-26-005). v1 callers pass "every installed pack", but the
// FILTER is the API from day one: composition-at-initiation becomes a different
// argument at one call site, not a rewrite of every consumer. That is the
// single design decision this module exists to make cheap.

/**
 * A pack's name. A plain string at runtime; the string LITERAL type is what
 * makes ownership checkable, so packs declare their names as literals
 * (`const TS_PACK = "ts"`) rather than as widened `string`.
 */
export type PackName = string;

/**
 * Verdict of a socket's validation hook: `undefined` accepts, a string
 * refuses and IS the message the composer prints. A boolean would have made
 * every refusal say "invalid contribution", which tells the pack author
 * nothing they did not already know.
 */
export type SocketValidator<Value> = (value: Value, contributor: PackName) => string | undefined;

/**
 * The erased face of a socket: what the registry needs to know to place a
 * contribution, with the value type forgotten.
 *
 * `Owner` survives erasure deliberately. It is the type the dependency rule is
 * checked against, and a heterogeneous list of sockets (a pack defines several,
 * with different value types) has to forget the value type to be a list at all
 * — but it must NOT forget who owns them, or `defines: [...]` would accept a
 * socket belonging to somebody else.
 */
export interface SocketHandle<Owner extends PackName> {
  readonly id: string;
  readonly owner: Owner;
  readonly description: string;
}

/**
 * A socket: an extension point one pack defines and any pack depending on it
 * may fill.
 *
 * `__value` is a PHANTOM and is never present at runtime. It is optional, so
 * no socket literal has to invent one, and it is typed as
 * `(value: Value) => Value` — `Value` in both a parameter and a return
 * position, which makes the socket INVARIANT in its value type. A covariant
 * marker (`__value?: Value`) would let `Socket<string>` and `Socket<string |
 * number>` pass for each other in one direction, which is exactly the hole the
 * phantom exists to close.
 */
export interface Socket<Value, Owner extends PackName> extends SocketHandle<Owner> {
  readonly validate?: SocketValidator<Value>;
  readonly __value?: (value: Value) => Value;
}

/** What `socketsOwnedBy` takes: everything about a socket except its owner. */
export interface SocketSpec<Value> {
  readonly id: string;
  readonly description: string;
  readonly validate?: SocketValidator<Value>;
}

/**
 * The sockets one pack owns. Sockets are declared THROUGH their owner so the
 * owner is written once and inferred everywhere after:
 *
 * ```ts
 * const tsSockets = socketsOwnedBy("ts");
 * export const lintSrcRules = tsSockets.define<LintSrcRule>({ id: …, description: … });
 * ```
 *
 * The alternative — `defineSocket<LintSrcRule, "ts">({ owner: "ts", … })` —
 * spells the owner twice with nothing making the two agree, and TypeScript has
 * no partial type-argument inference that would let one call take an explicit
 * value type and an inferred owner.
 */
export interface SocketFactory<Owner extends PackName> {
  readonly owner: Owner;
  define<Value>(spec: SocketSpec<Value>): Socket<Value, Owner>;
}

export function socketsOwnedBy<Owner extends PackName>(owner: Owner): SocketFactory<Owner> {
  return {
    owner,
    define<Value>(spec: SocketSpec<Value>): Socket<Value, Owner> {
      return Object.freeze({ ...spec, owner });
    },
  };
}

/**
 * One pack's contribution to one socket, with the value type erased so
 * contributions to different sockets can sit in the same array.
 *
 * `Owner` is the pack that owns the TARGET socket, and it is the whole
 * mechanism: a pack definition accepts only `PackContribution<Name | Deps>`,
 * so a contribution to a socket owned by an undeclared pack fails to typecheck
 * with the offending pack name in the error text. The runtime check below says
 * the same thing in prose, for the callers that reached here dynamically.
 */
export interface PackContribution<Owner extends PackName> {
  readonly socketId: string;
  readonly socketOwner: Owner;
  /** Values as contributed, in declaration order. */
  readonly values: readonly unknown[];
  /** Run the socket's hook over this contribution's values, typed. */
  readonly validate: (contributor: PackName) => readonly string[];
}

/**
 * Bind values to a socket. The one place the value type is checked, and the
 * reason `read` below can hand them back typed without checking again.
 */
export function contribute<Value, Owner extends PackName>(
  socket: Socket<Value, Owner>,
  values: readonly Value[],
): PackContribution<Owner> {
  const check = socket.validate;
  return Object.freeze({
    socketId: socket.id,
    socketOwner: socket.owner,
    values,
    // The closure keeps `values` at its real type, so the hook is called with
    // what it declared it takes — no widening, and nothing to cast back.
    validate: (contributor: PackName): readonly string[] =>
      check === undefined
        ? []
        : values.map((v) => check(v, contributor)).filter((m): m is string => m !== undefined),
  });
}

/**
 * A pack as the registry sees it: a name, the packs it depends on, the sockets
 * it defines, and the contributions it makes.
 *
 * Erased in both phantom positions, because the composed set is a
 * heterogeneous list. `definePack` is the typed door in; this is the shape the
 * composer walks.
 */
export interface PackDefinition {
  readonly name: PackName;
  readonly dependsOnPacks: readonly PackName[];
  readonly defines: readonly SocketHandle<PackName>[];
  readonly contributes: readonly PackContribution<PackName>[];
}

/** The typed form of a pack definition — see `definePack`. */
export interface PackSpec<Name extends PackName, Dep extends PackName> {
  readonly name: Name;
  readonly dependsOnPacks: readonly Dep[];
  /** Sockets this pack owns. A socket owned by another pack does not typecheck
   *  here: a pack cannot define an extension point on somebody else's behalf. */
  readonly defines?: readonly SocketHandle<Name>[];
  /** Contributions to sockets owned by this pack or by a declared dependency.
   *  Any other owner is a compile error — this is the dependency edge, as a
   *  type. */
  readonly contributes?: readonly PackContribution<Name | Dep>[];
}

/**
 * Declare a pack.
 *
 * The signature carries the whole architectural rule: `contributes` is typed
 * `PackContribution<Name | Dep>`, so the only sockets a pack can fill are its
 * own and those of packs it named in `dependsOnPacks`. Adding a contribution to
 * a third pack's socket does not fail a review — it fails to compile, naming
 * the pack whose edge is missing.
 */
export function definePack<Name extends PackName, Dep extends PackName>(
  spec: PackSpec<Name, Dep>,
): PackDefinition {
  return Object.freeze({
    name: spec.name,
    dependsOnPacks: Object.freeze([...(spec.dependsOnPacks ?? [])]),
    defines: Object.freeze([...(spec.defines ?? [])]),
    contributes: Object.freeze([...(spec.contributes ?? [])]),
  });
}

/** Composition refused. Always names the pack, the socket, and the fix. */
export class SocketRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketRegistryError";
  }
}

/**
 * The composed result: every contribution of every composed pack, placed on the
 * socket it targets, in dependency order.
 *
 * Reads are by socket OBJECT, not by string id — the object carries the value
 * type, so a consumer asking a socket for its contributions gets them typed,
 * and asking for a socket the composition never saw is a compile error if the
 * socket is not imported and an empty read if it is.
 */
export class SocketRegistry {
  /** socket id → contributed values, in pack composition order. */
  readonly #values: ReadonlyMap<string, readonly unknown[]>;
  /** socket id → the handle that defined it, for read-time provenance. */
  readonly #sockets: ReadonlyMap<string, SocketHandle<PackName>>;
  /** Composed packs, dependency-ordered — dependencies before dependents. */
  readonly packs: readonly PackName[];

  constructor(
    values: ReadonlyMap<string, readonly unknown[]>,
    sockets: ReadonlyMap<string, SocketHandle<PackName>>,
    packs: readonly PackName[],
  ) {
    this.#values = values;
    this.#sockets = sockets;
    this.packs = Object.freeze([...packs]);
  }

  /**
   * Everything contributed to `socket`, frozen, in composition order.
   *
   * THE ONE UNCHECKED STEP IN THIS MODULE, and it is deliberate. The store is
   * heterogeneous — one map holding the values of every socket — so the value
   * type has to be forgotten on the way in and recovered on the way out. What
   * makes the recovery sound is that there is exactly ONE way in: `contribute`,
   * which is generic over the socket's own value type, so nothing can reach
   * this map whose type does not match the socket it was filed under. The cast
   * re-states a fact the write side already proved; TypeScript simply has no
   * existential type in which to carry the proof across a `Map`.
   *
   * It also does not ship into a target project — this is harness core, where
   * `lint-src`'s four-escape-hatch ban does not reach. A cast in a scaffolded
   * skeleton or a builder's module would be the defect that ban exists for.
   */
  read<Value, Owner extends PackName>(socket: Socket<Value, Owner>): readonly Value[] {
    const stored = this.#values.get(socket.id) ?? [];
    return Object.freeze([...stored]) as readonly Value[];
  }

  /** Was a socket with this id defined by a composed pack? */
  hasSocket(id: string): boolean {
    return this.#sockets.has(id);
  }

  /** Every socket the composed packs define, sorted by id — for reporting. */
  get sockets(): readonly SocketHandle<PackName>[] {
    return Object.freeze([...this.#sockets.values()].sort((a, b) => a.id.localeCompare(b.id)));
  }
}

/**
 * Compose packs into a registry.
 *
 * `compose` is the project's pack list: only the named packs take part, and
 * every other installed pack contributes nothing at all — not a filtered-out
 * value, not a defined-but-empty socket. Omit it and every pack in `installed`
 * is composed, which is what v1 callers want and what the harness does today.
 *
 * Refusals are loud and name the fix, because every one of them is a pack
 * author's mistake made at a seam where silence would produce a mystery: a
 * missing rule in a gate, weeks later, with nothing to grep for.
 */
export function composePacks(
  installed: readonly PackDefinition[],
  compose?: readonly PackName[],
): SocketRegistry {
  const byName = new Map<PackName, PackDefinition>();
  for (const pack of installed) {
    if (byName.has(pack.name)) {
      throw new SocketRegistryError(
        `two installed packs are both named '${pack.name}' — pack names are identities; rename one`,
      );
    }
    byName.set(pack.name, pack);
  }

  const wanted = compose ?? installed.map((p) => p.name);
  for (const name of wanted) {
    if (!byName.has(name)) {
      throw new SocketRegistryError(
        `pack '${name}' is composed but not installed — install it, or drop it from the composition`,
      );
    }
  }
  const composed = new Set(wanted);

  // Every declared dependency must itself be composed. A dependency that is
  // merely INSTALLED is not enough: the whole point of composition is that an
  // uncomposed pack's sockets do not exist, and a pack whose dependency's
  // sockets do not exist cannot be wired at all. Saying so here beats
  // discovering it as "unknown socket" further down.
  for (const name of wanted) {
    const pack = byName.get(name);
    if (pack === undefined) continue; // unreachable: checked above
    for (const dep of pack.dependsOnPacks) {
      if (composed.has(dep)) continue;
      const known = byName.has(dep) ? "installed but not composed" : "not installed";
      throw new SocketRegistryError(
        `pack '${name}' depends on pack '${dep}', which is ${known} — compose '${dep}' as well, ` +
          `or remove the dependency`,
      );
    }
  }

  const order = dependencyOrder(wanted, byName);

  // --- placement -----------------------------------------------------------
  const sockets = new Map<string, SocketHandle<PackName>>();
  const values = new Map<string, unknown[]>();

  // Sockets first, all of them, before any contribution is placed. Dependency
  // order already guarantees a dependency's sockets exist before its
  // dependents' contributions — but two packs may legally define sockets and
  // contribute to each other's within one composition level, and a two-pass
  // placement makes the outcome independent of the order the packs were listed
  // in. Composition must not depend on array order; only on declared edges.
  for (const name of order) {
    const pack = byName.get(name);
    if (pack === undefined) continue; // unreachable: checked above
    for (const socket of pack.defines) {
      if (socket.owner !== pack.name) {
        throw new SocketRegistryError(
          `pack '${pack.name}' defines socket '${socket.id}', which declares pack '${socket.owner}' ` +
            `as its owner — a pack may only define its own sockets`,
        );
      }
      const existing = sockets.get(socket.id);
      if (existing !== undefined) {
        throw new SocketRegistryError(
          `socket id '${socket.id}' is defined twice (packs '${existing.owner}' and '${socket.owner}') — ` +
            `socket ids are global; give one of them a distinct id`,
        );
      }
      sockets.set(socket.id, socket);
      values.set(socket.id, []);
    }
  }

  for (const name of order) {
    const pack = byName.get(name);
    if (pack === undefined) continue; // unreachable: checked above
    const declared = new Set<PackName>([pack.name, ...pack.dependsOnPacks]);
    for (const contribution of pack.contributes) {
      placeContribution(pack, contribution, declared, sockets, values);
    }
  }

  const frozen = new Map<string, readonly unknown[]>();
  for (const [id, list] of values) frozen.set(id, Object.freeze([...list]));
  return new SocketRegistry(frozen, sockets, order);
}

function placeContribution(
  pack: PackDefinition,
  contribution: PackContribution<PackName>,
  declared: ReadonlySet<PackName>,
  sockets: ReadonlyMap<string, SocketHandle<PackName>>,
  values: ReadonlyMap<string, unknown[]>,
): void {
  // The runtime half of the phantom owner type. The compile error is the one
  // that matters — it fires before anything runs — but a pack reaching here
  // through a dynamically built definition would otherwise get its
  // contribution placed with no edge behind it, which is the implicit
  // dependency TN-26-005 exists to forbid.
  if (!declared.has(contribution.socketOwner)) {
    throw new SocketRegistryError(
      `pack '${pack.name}' contributes to socket '${contribution.socketId}', owned by pack ` +
        `'${contribution.socketOwner}' — but '${pack.name}' does not declare '${contribution.socketOwner}' ` +
        `in dependsOnPacks. Add the dependency edge, or move the contribution to a pack that has it; ` +
        `no pack depends on another implicitly (TN-26-005).`,
    );
  }

  const socket = sockets.get(contribution.socketId);
  const sink = values.get(contribution.socketId);
  if (socket === undefined || sink === undefined) {
    throw new SocketRegistryError(
      `pack '${pack.name}' contributes to socket '${contribution.socketId}', which pack ` +
        `'${contribution.socketOwner}' does not define — check the socket id, or the version of ` +
        `'${contribution.socketOwner}' this composition installed`,
    );
  }
  if (socket.owner !== contribution.socketOwner) {
    throw new SocketRegistryError(
      `pack '${pack.name}' contributes to socket '${contribution.socketId}' as if pack ` +
        `'${contribution.socketOwner}' owned it, but it is owned by pack '${socket.owner}'`,
    );
  }

  const problems = contribution.validate(pack.name);
  if (problems.length > 0) {
    throw new SocketRegistryError(
      `pack '${pack.name}' contributes an invalid value to socket '${socket.id}': ${problems.join("; ")}`,
    );
  }
  sink.push(...contribution.values);
}

/**
 * Composed packs, dependencies first, with cycles refused by name.
 *
 * Order matters because contributions are read in order and some sockets are
 * order-sensitive by nature — a list of flat-config blocks is applied last to
 * first, so "the pack I depend on goes before me" is the difference between an
 * override that lands and one that is silently overwritten.
 *
 * Depth-first with a three-state mark (unseen / on the current path / done);
 * the path itself is carried so a refusal can print the cycle rather than the
 * fact that there is one.
 */
function dependencyOrder(
  wanted: readonly PackName[],
  byName: ReadonlyMap<PackName, PackDefinition>,
): readonly PackName[] {
  const order: PackName[] = [];
  const done = new Set<PackName>();
  const onPath = new Set<PackName>();

  const visit = (name: PackName, path: readonly PackName[]): void => {
    if (done.has(name)) return;
    if (onPath.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name].join(" → ");
      throw new SocketRegistryError(
        `pack dependency cycle: ${cycle} — packs form a hierarchy; break the loop by moving the ` +
          `shared part into a pack both can depend on`,
      );
    }
    onPath.add(name);
    const pack = byName.get(name);
    // Dependencies were proved composed before this walk started, so a missing
    // entry here cannot happen; skipping rather than throwing keeps the cycle
    // message the only refusal this function can produce.
    for (const dep of pack?.dependsOnPacks ?? []) visit(dep, [...path, name]);
    onPath.delete(name);
    done.add(name);
    order.push(name);
  };

  // Sorted, so composition order is a function of the declared edges and the
  // pack NAMES — never of how the installed list happened to be assembled.
  for (const name of [...wanted].sort()) visit(name, []);
  return order;
}
