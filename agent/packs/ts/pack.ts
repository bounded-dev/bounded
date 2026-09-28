// The ts pack as a pack DEFINITION (TN-26-005, "two-level sockets").
//
// The core owns language-agnostic mechanisms only, so "ESLint rules" is not a
// core socket and never will be — agent/src/socket-registry.ts contains no word
// for ESLint. The ts pack owns the TypeScript family's gates, so the ts pack
// defines the sockets those gates read, and packs that depend on ts (ts-web
// today) fill them. The core learns that a pack declared a socket and another
// pack filled it, and nothing more.
//
// FIVE SOCKETS — two for the gates that lint, one for the delivery pass, one
// for the scaffolder and red gate, one for the artifact-generation gate:
//
//   lintSrcRules             extra rules for the src gate (implementation code)
//   contractPurityOverrides  extra flat-config blocks for the contract gate
//   deliverChecks            read-only checks run at the end of delivery
//                            (ADR 2026-033)
//   contractSupportFiles     canonical files a contract import asks for
//                            (ADR 2026-046)
//   artifactGenerators       deterministic generators the architect's
//                            generate_artifacts gate runs (ADR 2026-055)
//
// The ts pack's OWN rules are not contributions. `SRC_RULE_IDS` and
// `CONTRACT_RULE_IDS` stay hard-wired in their gates: the gate and the plugin
// are the same pack, a pack contributing to itself through a registry buys
// nothing, and a gate whose base config could be composed away is not a gate.
// The sockets exist for the rules of OTHER packs.
//
// The data-only layer is unaffected. Intake nouns and component return-type
// names stay in `contrib.json` (agent/src/pack-contrib.ts), because the host
// must be able to read those without executing pack code. These two sockets
// carry FUNCTIONS — an ESLint rule is code — which is exactly the line
// TN-26-005 draws between the two halves.

import type { TSESLint } from "@typescript-eslint/utils";
import { definePack, socketsOwnedBy } from "../../src/socket-registry.ts";

/** This pack's name, as a literal — the registry checks ownership by type, so
 *  a widened `string` here would quietly switch the compile-time half off. */
export const TS_PACK = "ts";

const tsSockets = socketsOwnedBy(TS_PACK);

/**
 * Which role's brief must name a contributed rule.
 *
 * ADR 2026-018 (guards and briefs are bidirectional): everything a guard
 * enforces on a role must also be TOLD to that role, or the agent learns the
 * rule from a block and every run pays the bounce. A contributed rule is
 * enforced exactly like a built-in, so it carries the same obligation — and
 * carries it as DATA, so `guard-doc-drift.test.ts` can check it without the
 * core knowing which packs exist.
 *
 * It doubles as the rule's scope: the builder writes `src/**`, the test-writer
 * writes `tests/**`, so the brief a rule binds is also the tree it polices.
 */
export type RoleBrief = "builder" | "test-writer";

/**
 * One ESLint rule contributed to the src gate.
 *
 * `plugin` is the flat-config namespace the rule is registered under, and it is
 * the CONTRIBUTING pack's, never `bounded-ts`: two packs owning rules in one
 * namespace is a collision waiting for the first name clash, and the rule id a
 * block prints should say which pack to go and read.
 */
export interface LintSrcRuleContribution {
  /** Flat-config plugin namespace, e.g. `bounded-ts-web`. */
  readonly plugin: string;
  /** Rule name within that namespace, e.g. `fsd-downward-imports`. */
  readonly name: string;
  /** The rule module itself. */
  readonly rule: TSESLint.AnyRuleModule;
  /** The brief that must name it, and the tree it binds. */
  readonly namedIn: RoleBrief;
}

/** `bounded-ts-web/fsd-downward-imports` — derived, never stored, so the id
 *  a gate enforces and the id a brief is checked against cannot drift apart. */
export function lintSrcRuleId(contribution: LintSrcRuleContribution): string {
  return `${contribution.plugin}/${contribution.name}`;
}

const RULE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const lintSrcRules = tsSockets.define<LintSrcRuleContribution>({
  id: "lintSrcRules",
  description:
    "Extra ESLint rules for the lint-src gate, contributed by packs that depend on ts. " +
    "Each names the role brief that must mention it, so a contributed rule carries the same " +
    "bidirectional obligation as a built-in one (ADR 2026-018).",
  // Refuse at the seam. A malformed contribution reaching the gate would
  // surface as an ESLint config crash with no pack name in it — one layer down
  // from where the mistake was made, and three words shorter than useless.
  validate: (rule, contributor) => {
    if (rule.plugin.trim() === "") return `${contributor} contributed a rule with no plugin namespace`;
    if (!RULE_NAME.test(rule.name)) {
      return `'${rule.name}' is not a usable rule name (lowercase, dash-separated) — the id a block prints is ${rule.plugin}/${rule.name}`;
    }
    if (typeof rule.rule.create !== "function") {
      return `'${lintSrcRuleId(rule)}' has no create() — that is not an ESLint rule module`;
    }
    if (rule.namedIn !== "builder" && rule.namedIn !== "test-writer") {
      return `'${lintSrcRuleId(rule)}' declares namedIn '${String(rule.namedIn)}' — it must be the brief of a role that writes the tree the rule polices`;
    }
    return undefined;
  },
});

/**
 * One extra flat-config block for the contract-purity gate.
 *
 * Both directions are legal and both are needed. ADDING a rule for a narrower
 * set of contracts is how a pack tightens its own corner; DOWNGRADING one to
 * `"off"` is how a pack states an exemption its own reference set ratified —
 * TN-26-006's Button `label: string`, where a value object would be ceremony
 * over a primitive that genuinely is one. Appending a block is the only shape
 * flat config offers for either, so it is the shape the socket carries.
 *
 * `why` is not decoration: a relaxation with no recorded reason is
 * indistinguishable from a rule someone found inconvenient, and this is the
 * one socket whose contributions can make a gate weaker.
 */
export interface ContractPurityOverride {
  /** Globs the block applies to. A relaxation is always narrower than
   *  `**\/*.contract.ts`; an addition a pack owns may cover every contract. */
  readonly files: readonly string[];
  /**
   * OPTIONAL: the contributing pack's own rules, registered under its own
   * flat-config namespace (never `bounded-ts`) so `rules` can name them. This is
   * how a pack adds a contract rule the ts pack does not ship (ADR 2026-046).
   */
  readonly plugin?: {
    readonly namespace: string;
    readonly rules: Readonly<Record<string, TSESLint.AnyRuleModule>>;
  };
  /** Rule id → severity. `"off"` is a relaxation; `"error"` an addition. */
  readonly rules: Readonly<Record<string, "error" | "off">>;
  /** Why this block exists, in one sentence, with the note that ratified it. */
  readonly why: string;
}

export const contractPurityOverrides = tsSockets.define<ContractPurityOverride>({
  id: "contractPurityOverrides",
  description:
    "Extra flat-config blocks appended to the contract-purity gate by packs that depend on ts: " +
    "additional rules for a narrower file set, or ratified relaxations of the base rules.",
  validate: (override, contributor) => {
    if (override.files.length === 0) {
      return `${contributor} contributed a purity override with no files glob — a block that matches everything is a rewrite of the gate, not an override`;
    }
    if (Object.keys(override.rules).length === 0) {
      return `${contributor} contributed a purity override for ${override.files.join(", ")} with no rules`;
    }
    if (override.plugin !== undefined && (override.plugin.namespace === "bounded-ts" || override.plugin.namespace.trim() === "")) {
      return `${contributor} contributed a purity plugin namespace '${override.plugin.namespace}' — use the pack's own namespace`;
    }
    if (override.why.trim() === "") {
      return `${contributor} contributed a purity override for ${override.files.join(", ")} with no reason — a relaxation without a recorded reason is a rule someone found inconvenient`;
    }
    return undefined;
  },
});

// --- deliverChecks (ADR 2026-033) --------------------------------------------
//
// The third socket, and the first one that is not about lint. `deliver` is the
// ts pack's script and the last thing that runs on a finished run — the one
// moment the whole tree exists, every gate has passed, and somebody is reading
// the output. A pack that ships a reference set into that tree has claims about
// it that no lint rule can check, because they are about FILES the project owns
// rather than code a rule can parse: ts-web's claim is that `src/ui/theme.css`
// still defines every token its kit styles through, and that the colours in it
// are readable.
//
// Born WITH its consumer, which is the socket policy (TN-26-005): the step in
// `deliver.ts` and this declaration land in the same change, and neither exists
// without the other.

/** What a contributed check reports. One verdict, one summary line, and as much
 *  detail as the reader needs to act — the numbers, not the transcript. */
export interface DeliverCheckResult {
  readonly verdict: "pass" | "block";
  /** One line, printed beside the check's name. */
  readonly summary: string;
  /** Extra lines, printed indented under it. Empty is normal. */
  readonly detail?: readonly string[];
}

/**
 * A package.json script a pack's acceptance should ALSO become, so the
 * DELIVERED repo's own `npm run check` carries it once the harness is gone.
 *
 * `command` names a technology (a build tool, a bundler), which is exactly why
 * it lives in the contributing pack and never in `deliver.ts`: deliver reads
 * `{ name, command }` and writes them into the target, learning no framework
 * name — the same way it folds `check:surface` in without knowing what
 * ts-morph is (TN-26-005).
 */
export interface DeliverCheckScript {
  /** npm script name, e.g. `check:build`. Lowercase, `check:`-prefixed by
   *  convention so a reader groups it with `check:surface`. */
  readonly name: string;
  /** The command the script runs, e.g. `vite build`. */
  readonly command: string;
}

/**
 * One check a pack contributes to the delivery pass.
 *
 * READ-ONLY, and that is a contract rather than a convention: every mutating
 * step in `deliver` is deliver's own, so a contributed check that wrote to the
 * tree would be changing a repo AFTER the repo's own `npm run check` passed
 * over it — the one thing delivery must never do. A check answers a question
 * about the tree it was handed.
 */
export interface DeliverCheck {
  /** Step name, printed in deliver's line and logged as the guard step. */
  readonly name: string;
  /** What it verifies, in one sentence — read by nobody at runtime, and by
   *  everybody trying to work out why a delivery blocked. */
  readonly description: string;
  /** Run it against a target project root. Must not write. */
  readonly run: (cwd: string, packs: readonly string[]) => DeliverCheckResult;
  /**
   * OPTIONAL: a script deliver folds into the project's own `check`, so the
   * delivered repo's definition of done includes this acceptance (mirrors how
   * deliver folds `check:surface`). Returns the script for a tree this check
   * applies to, or `undefined` when the tree is not this pack's kind of target
   * — the folding is keyed on the tree exactly as `run` is, so a service
   * delivered by a ts-web-composed harness gets no web build folded in.
   *
   * Dogfood Run 29 is why this exists: a composed web app whose `npm run check`
   * passed while `vite build` failed, because check's scope never reached the
   * web bootstrap. Folding the build into `check` closes that permanently, in
   * the shipped repo and not only at the delivery gate.
   *
   * TODO(generalize): today the one consumer (ts-web's build) is also a
   * `deliverCheck`, so the fold rides this socket. A future pack that must fold
   * a script that is NOT also a deliverCheck is the signal to promote this to
   * its own `deliverCheckScripts` socket — a pure lift, no consumer rewrite.
   */
  readonly checkScript?: (cwd: string) => DeliverCheckScript | undefined;
}

const CHECK_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const deliverChecks = tsSockets.define<DeliverCheck>({
  id: "deliverChecks",
  description:
    "Read-only checks contributed by packs that depend on ts, run as the last step of the " +
    "delivery pass. Each returns pass or block with the lines a reader needs; a block stops " +
    "delivery exactly as deliver's own steps do.",
  validate: (check, contributor) => {
    if (!CHECK_NAME.test(check.name)) {
      return `${contributor} contributed a delivery check named '${check.name}' — the name is printed as a step, so it must be lowercase and dash-separated`;
    }
    if (check.description.trim() === "") {
      return `${contributor}'s '${check.name}' check has no description — a step that can block delivery has to say what it verifies`;
    }
    if (typeof check.run !== "function") {
      return `${contributor}'s '${check.name}' check has no run() — there is nothing to call`;
    }
    if (check.checkScript !== undefined && typeof check.checkScript !== "function") {
      return `${contributor}'s '${check.name}' check has a checkScript that is not a function — it must derive the fold from the tree`;
    }
    return undefined;
  },
});

// --- artifactGenerators (ADR 2026-055) --------------------------------------
//
// Born with its consumer, the `generate_artifacts` gate
// (scripts/generate-artifacts.ts). Some project files are derived from files a
// role writes and must never be hand-edited: a versioned migration derived
// from a schema. No role has a shell to run the derivation, and no role may
// write the output, so the architect calls one generic gate and each composed
// pack contributes its generator. A project that composes no generator runs
// none; the gate names no technology.

/** A selected pack's deterministic project artifact generator. */
export interface ArtifactGenerator {
  /** Printed before each output line and logged; lowercase, dash-separated. */
  readonly name: string;
  /** Write the derived files into the project at `cwd` and return what it
   *  did, one line each. Throws, with a message a reader can act on, when it
   *  cannot generate; the gate then blocks and writes nothing further. */
  readonly run: (cwd: string) => readonly string[];
}

export const artifactGenerators = tsSockets.define<ArtifactGenerator>({
  id: "artifactGenerators",
  description:
    "Deterministic generators, contributed by packs that depend on ts, for project files derived " +
    "from role-written inputs. The architect's generate_artifacts gate runs every composed one.",
  validate: (generator, contributor) =>
    /^[a-z][a-z0-9-]*$/.test(generator.name) && typeof generator.run === "function"
      ? undefined : `${contributor} supplied an invalid artifact generator`,
});

// --- contractSupportFiles (ADR 2026-046) -------------------------------------
//
// A contract can name a support module that is machinery, not business code:
// a service contract imports "./service-runtime.js", and the answer is one
// canonical file copied verbatim to that path. The ts scaffolder (live tree)
// and the red gate (shadow project) are the consumers; the pack that owns the
// capability owns the file and the rule for where it lands. A project that has
// not composed that pack gets no support file at all — the contract's import
// then fails to resolve, which is the honest outcome.

/** One contract-triggered support file a pack ships through the scaffolder. */
export interface ContractSupportFile {
  /** What the file is, printed in the scaffold line, e.g. `API-service runtime`. */
  readonly label: string;
  /** Harness-relative path of the canonical copy, written into the generated
   *  marker, e.g. `packs/ts-service/api/service-runtime.ts`. */
  readonly canonical: string;
  /** Absolute paths this contract asks for; empty when it asks for none. */
  readonly targets: (contractSource: string, contractPath: string) => readonly string[];
  /** The canonical file's text, without any marker. */
  readonly source: () => string;
  /** Packages the shipped file imports. Delivery pins and installs them as
   *  regular dependencies when the tree carries this file. */
  readonly dependencies?: readonly string[];
}

export const contractSupportFiles = tsSockets.define<ContractSupportFile>({
  id: "contractSupportFiles",
  description:
    "Canonical support files a pack that depends on ts ships verbatim when a contract imports " +
    "them. The scaffolder writes them into the live tree and the red gate into its shadow project.",
  validate: (file, contributor) => {
    if (file.label.trim() === "") return `${contributor} contributed a contract support file with no label`;
    if (!file.canonical.startsWith(`packs/${contributor}/`)) {
      return `${contributor}'s '${file.label}' names canonical '${file.canonical}' — a pack ships only its own files`;
    }
    if (typeof file.targets !== "function" || typeof file.source !== "function") {
      return `${contributor}'s '${file.label}' needs targets() and source() functions`;
    }
    return undefined;
  },
});

/**
 * The ts pack. Depends on nothing — it is the root of the TypeScript family —
 * and contributes nothing: its own rules are its gates' base config.
 */
export const tsPack = definePack({
  name: TS_PACK,
  dependsOnPacks: [],
  defines: [lintSrcRules, contractPurityOverrides, deliverChecks, contractSupportFiles, artifactGenerators],
});
