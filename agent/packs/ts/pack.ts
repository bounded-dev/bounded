// The ts pack as a pack DEFINITION (TN-26-005, "two-level sockets").
//
// The core owns language-agnostic mechanisms only, so "ESLint rules" is not a
// core socket and never will be — agent/src/socket-registry.ts contains no word
// for ESLint. The ts pack owns the TypeScript family's gates, so the ts pack
// defines the sockets those gates read, and packs that depend on ts (ts-web
// today) fill them. The core learns that a pack declared a socket and another
// pack filled it, and nothing more.
//
// CODE SOCKETS — two for the gates that lint, one for the delivery pass, one
// for the artifact-generation gate, and three for the design, red and green
// gates (the contract-support-file socket of ADR 2026-046 is retired):
//
//   lintSrcRules             extra rules for the src gate (implementation code)
//   contractPurityOverrides  extra flat-config blocks for the contract gate
//   deliverChecks            read-only checks run at the end of delivery
//                            (ADR 2026-033)
//   artifactGenerators       deterministic generators the architect's
//                            generate_artifacts gate runs (ADR 2026-055)
//   skeletonEmitters         files derived from the design contracts, as
//                            skeletons or generated files (ADR 2026-060)
//   phaseTestPolicies        per-phase rules for tests that need the machine
//                            (a container runtime; ADR 2026-064)
//   testObligations          per-level test files and reach (ADR 2026-063)
//
// Two DATA sockets are owned here too, read from contrib.json by the readers
// at the end of this file: `adapterTechnologies` and `workspaceTemplates`
// (ADR 2026-061). They are data because the workspace generator must read
// them without executing pack code, exactly like `pins`.
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

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSESLint } from "@typescript-eslint/utils";
import { contributionsByPack } from "../../src/pack-contrib.ts";
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

// --- skeletonEmitters (ADR 2026-060) ------------------------------------------
//
// Everything mechanical is generated from the frozen design (TN-26-012). An
// emitter is a pure function from the project's facts to the files it
// derives. Its consumers are the design gate's scaffold step (live tree), the
// red gate (shadow project) and delivery's leftover check; they alone decide
// what is written where, so an emitter never touches the disk.
//
//   skeleton   builder-owned once written: the consumer writes it only where
//              no file exists, and the red shadow regenerates it fresh.
//   generated  owned by the generator: every role is write-denied (its path
//              must match a composed `generatedFileGlobs` entry) and a gate
//              refuses when the tree differs from what the emitters produce.

/** Which gate is asking. Emitters of red-phase-only files (the
 *  not-implemented error module) emit nothing at `deliver`. */
export type EmitPhase = "design" | "red" | "deliver";

/** Ownership of an emitted file; see the section note above. */
export type EmitMode = "skeleton" | "generated";

export interface EmittedFile {
  /** Project-relative, `/`-separated, no `.`/`..` segment, no leading `/`. */
  readonly path: string;
  /** Exact file text, ending with a newline. */
  readonly content: string;
  readonly mode: EmitMode;
  /** A build entry point of its workspace: the workspace generator lists
   *  every such file in the manifest template's `{{entries}}` (TN-26-012 §10),
   *  e.g. one per Lambda. Absent for every other file. */
  readonly entry?: true;
}

/** A design contract file as it stands on disk. */
export interface ContractSource {
  /** Project-relative path, carrying a composed contract suffix. */
  readonly path: string;
  readonly source: string;
}

/** One workspace of the project: a context derived from contract paths, or
 *  an app declared in a TN's `workspaces:` map (ADR 2026-061). */
export interface WorkspaceFacts {
  /** e.g. `contexts/project-management`, `apps/web`. */
  readonly dir: string;
  /** Last segment of `dir`, e.g. `project-management`. */
  readonly name: string;
  /** The `workspaceTemplates` kind, e.g. `context`, `web`. */
  readonly kind: string;
  /** `<scope>/<name>`, e.g. `@example/project-management`. */
  readonly packageName: string;
  /** The concrete source root inside it, e.g. `contexts/project-management/src`. */
  readonly sourceRoot: string;
  /** Contract files under `sourceRoot`, sorted by path. */
  readonly contracts: readonly ContractSource[];
}

/** Everything an emitter may know. Pure data: no paths outside the project,
 *  no clock, no environment, so the same design always emits the same bytes. */
export interface ProjectFacts {
  /** The package scope, `@` included, e.g. `@example`. */
  readonly scope: string;
  readonly phase: EmitPhase;
  /** Composed packs, dependency-ordered. */
  readonly packs: readonly string[];
  /** Sorted by `dir`. */
  readonly workspaces: readonly WorkspaceFacts[];
  /** The composed packs' adapter technologies, sorted by id. */
  readonly adapterTechnologies: readonly AdapterTechnology[];
  /** The composed packs' workspace templates, sorted by kind. */
  readonly workspaceTemplates: readonly WorkspaceTemplate[];
}

export interface Emitter {
  /** Printed in the scaffold and drift lines; lowercase, dash-separated. */
  readonly name: string;
  /** What it emits, in one sentence. */
  readonly description: string;
  /** Pure: same facts, same files. Throws, naming the contract and the fix,
   *  when the design cannot be emitted; the gate then blocks. */
  readonly emit: (facts: ProjectFacts) => readonly EmittedFile[];
}

const EMITTER_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const skeletonEmitters = tsSockets.define<Emitter>({
  id: "skeletonEmitters",
  description:
    "Emitters, contributed by packs that depend on ts, that derive skeleton and generated files from the " +
    "design contracts. The design gate writes their output, the red gate emits into its shadow, and delivery " +
    "checks that generated files are in sync.",
  validate: (emitter, contributor) => {
    if (!EMITTER_NAME.test(emitter.name)) {
      return `${contributor} contributed an emitter named '${emitter.name}' — it must be lowercase and dash-separated`;
    }
    if (emitter.description.trim() === "") return `${contributor}'s '${emitter.name}' emitter has no description`;
    if (typeof emitter.emit !== "function") return `${contributor}'s '${emitter.name}' emitter has no emit()`;
    return undefined;
  },
});

const PROJECT_PATH_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Why an emitted file is unusable, or undefined. Consumers call it on every
 * file before writing anything, and also refuse two files at one path.
 */
export function emittedFileProblem(file: EmittedFile, emitter: string): string | undefined {
  const segments = file.path.split("/");
  if (!segments.every((s) => PROJECT_PATH_SEGMENT.test(s)) ||
      segments.some((s) => [".git", ".bounded"].includes(s.toLowerCase()))) {
    return `emitter '${emitter}' produced an unsafe path '${file.path}'`;
  }
  if (file.mode !== "skeleton" && file.mode !== "generated") {
    return `emitter '${emitter}' produced '${file.path}' with mode '${String(file.mode)}'`;
  }
  if (!file.content.endsWith("\n")) return `emitter '${emitter}' produced '${file.path}' without a final newline`;
  if (file.entry !== undefined && file.entry !== true) return `emitter '${emitter}' produced '${file.path}' with entry '${String(file.entry)}'`;
  return undefined;
}

// --- phaseTestPolicies (ADR 2026-064) -----------------------------------------
//
// Some test levels need something from the machine that the others do not:
// store tests need a container runtime. The rule for WHEN such tests may be
// skipped is the owning pack's (ts-drizzle-postgres knows what a store test
// is); the red and green gates and the builder's run_tests (`build`) are the
// consumers and apply every composed policy to the test process they spawn.
// The ts pack cannot import a pack that depends on it, so the rule reaches
// the gates through this socket.

/** Which run is asking: the red gate, the builder's run_tests, or the green
 *  gate (and the mutation measurement, which runs under green's rules). */
export type TestPhase = "red" | "build" | "green";

export interface PhaseTestContext {
  /** The project the gate judges (the live tree; red's shadow mirrors it). */
  readonly project: string;
  readonly phase: TestPhase;
}

/** Something the machine provides for one gate's test run (a throwaway
 *  database), already started: what the test process must see, and how to
 *  take it down. The gate releases it after the run, on failure too. */
export interface PreparedTestService {
  /** One line for the gate's output, e.g. what was started and where. */
  readonly description: string;
  /** Set in the test process's environment, overriding any inherited value. */
  readonly env: Readonly<Record<string, string>>;
  /** Idempotent, synchronous (it also runs from a signal handler); never throws. */
  readonly release: () => void;
}

/** How a gate changes the test process's environment. */
export interface TestEnvChange {
  readonly set: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
}

/** One failing result of a gate's run, as the gate saw it. */
export interface TestFailure {
  readonly name: string;
  readonly message?: string;
  /** Project-relative test file, when the report names one. */
  readonly file?: string;
}

export type PhaseTestDecision =
  /** Run; remove `unsetEnv` from the test process's environment. With
   *  `prepare`, the gate starts the service just before the run (a throw
   *  blocks the gate with its message, routed to the orchestrator), sets
   *  its `env`, and releases it afterwards. With `infrastructureFailure`,
   *  green asks it about every failure: a returned cause means the machine,
   *  not the code, failed that test. Only when every failure is claimed does
   *  the gate route to the orchestrator; otherwise the claimed causes ride
   *  along as a note. It must be conservative: unsure means unclaimed.
   *  With `exclude` (build only), the run leaves those project-relative test
   *  files out and prints `reason`; at red or green an exclusion is a policy
   *  defect, read as a refusal. */
  | {
      readonly action: "run";
      readonly unsetEnv: readonly string[];
      readonly exclude?: { readonly files: readonly string[]; readonly reason: string };
      /** Gets the run's environment change so far (the policies' set and
       *  unset, earlier services' env included), as the test process will
       *  see it. */
      readonly prepare?: (env: TestEnvChange) => Promise<PreparedTestService>;
      readonly infrastructureFailure?: (failure: TestFailure) => string | undefined;
    }
  /** Red only: run with `env` set, and accept a skipped result exactly when
   *  `skippedTest(name)` holds for it. The gate prints `reason`. */
  | {
      readonly action: "skip";
      readonly reason: string;
      readonly env: Readonly<Record<string, string>>;
      readonly unsetEnv: readonly string[];
      readonly skippedTest: (resultName: string) => boolean;
    }
  /** Green only: do not run; block with `reason`. */
  | { readonly action: "refuse"; readonly reason: string; readonly unsetEnv: readonly string[] };

export interface PhaseTestPolicy {
  /** Lowercase, dash-separated. */
  readonly name: string;
  readonly description: string;
  /** Deterministic for a given machine and tree; may probe the machine. */
  readonly decide: (context: PhaseTestContext) => PhaseTestDecision;
}

export const phaseTestPolicies = tsSockets.define<PhaseTestPolicy>({
  id: "phaseTestPolicies",
  description:
    "Per-phase rules, contributed by packs that depend on ts, for test levels that need something from the " +
    "machine (a container runtime for store tests): the red gate may skip such tests with a logged reason, " +
    "the builder's run_tests may leave them out with the reason printed, and the green gate refuses rather than " +
    "skip them.",
  validate: (policy, contributor) => {
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(policy.name)) return `${contributor} contributed a phase test policy named '${policy.name}'`;
    if (policy.description.trim() === "") return `${contributor}'s '${policy.name}' policy has no description`;
    if (typeof policy.decide !== "function") return `${contributor}'s '${policy.name}' policy has no decide()`;
    return undefined;
  },
});

// --- testObligations (ADR 2026-063) --------------------------------------------
//
// What a suite owes, per test level, beyond going red for the right reason:
// the files each level needs and the members its tests must reach. The level
// structure is the layout pack's (ts-hexagonal knows what a handler, a store
// or an app is), so it reaches the ts gates through this socket. The ts pack's
// own domain obligations are prepended by the gates, as the domain emitter is.

/** A file under a source root, as an obligation reads it. */
export interface ObligationSource {
  /** Project-relative, `/`-separated. */
  readonly path: string;
  readonly source: string;
}

export interface ObligationInput {
  readonly facts: ProjectFacts;
  readonly phase: TestPhase;
  /** Every file under the composed source roots, project-relative, sorted. */
  readonly files: readonly string[];
  /** Test-side files a role wrote (generated ones excluded). */
  readonly tests: readonly ObligationSource[];
  /** Generated test-side files (laws). */
  readonly generatedTests: readonly ObligationSource[];
  /** `<Class>.<member>` names a red run's NotImplementedError failures named. */
  readonly reached: ReadonlySet<string>;
}

/** One unmet obligation, in words the test-writer can act on. */
export interface ObligationGap {
  /** The test level, e.g. `domain`, `feature`, `store`, `app`. */
  readonly level: string;
  /** The file to write or change, when there is one. */
  readonly path?: string;
  readonly message: string;
}

export interface TestObligation {
  /** Lowercase, dash-separated. */
  readonly name: string;
  readonly description: string;
  /** The gates that check it: `red` (the default) for levels the test-writer
   *  owes before the builder starts, `green` for levels only a built project
   *  can run, such as an app's smoke test. */
  readonly phases?: readonly TestPhase[];
  /** Pure over its input. Throws only on a design it cannot read. */
  readonly check: (input: ObligationInput) => readonly ObligationGap[];
}

export const testObligations = tsSockets.define<TestObligation>({
  id: "testObligations",
  description:
    "Per-level test obligations, contributed by packs that depend on ts: the test files each level of the design " +
    "needs and the members its tests must reach. The red gate checks them over the test-writer's suite; the green " +
    "gate checks the green-only levels.",
  validate: (obligation, contributor) => {
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(obligation.name)) return `${contributor} contributed a test obligation named '${obligation.name}'`;
    if (obligation.description.trim() === "") return `${contributor}'s '${obligation.name}' obligation has no description`;
    if (typeof obligation.check !== "function") return `${contributor}'s '${obligation.name}' obligation has no check()`;
    return undefined;
  },
});

// --- data sockets: adapterTechnologies, workspaceTemplates (ADR 2026-061) -----

function defaultPacksDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const PACK_FILE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const WORKSPACE_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
/** Words the hexagonal naming table already gives a file role; an in
 *  adapter's feature role may not reuse one. */
const RESERVED_ROLES = new Set(["contract", "command", "handler", "store", "mapper", "router", "test", "laws", "index"]);

/** Exact dependency pins, the same shape as a contrib.json `pins` field. */
export interface Pins {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

/** One adapter technology a pack makes available (ADR 2026-061). */
export interface AdapterTechnology {
  /** The contributing pack. */
  readonly pack: string;
  /** Kebab-case. It is the folder under `adapters/<direction>/`, the token in
   *  `@exposedVia` / `@implementedBy`, the export path `./adapters/<id>` and,
   *  PascalCased, the class prefix (`in-memory` → `InMemory`). */
  readonly id: string;
  readonly direction: "in" | "out";
  /** In adapters only: the feature file's role suffix (`procedure`, `tool`,
   *  `lambda`). */
  readonly featureRole?: string;
  /** Out adapters only: implements every `<Feature>Store` port, and has a
   *  shared `<Prefix>Database` in `<id>-database.ts`. False for in adapters. */
  readonly storage: boolean;
  /** Storage technologies only: whether `<Prefix>Database` is exported as a
   *  value (a class, `InMemoryDatabase`) or only as a type (an alias,
   *  `DrizzleDatabase`). The out barrel re-exports it with `export` or
   *  `export type` accordingly; a type re-exported as a value is "export not
   *  found" at runtime. Absent for every other technology. */
  readonly database?: "value" | "type";
  /** Pins a context workspace takes when its design uses this technology. */
  readonly pins: Pins;
  /** Pins every app workspace takes, keyed by the app template's `runtime`,
   *  when any context's design uses this technology: what a composition root
   *  needs to construct the technology for that runtime (a database driver).
   *  Present only when the contrib entry declares it (ADR 2026-061). */
  readonly appPins?: Readonly<Record<string, Pins>>;
  /** Scripts a context workspace's manifest takes when its tree has this
   *  technology's folder (`db:generate` → `drizzle-kit generate`), keys
   *  sorted. Present only when the contrib entry declares it. A script name
   *  belongs to one technology across the composition. */
  readonly workspaceScripts?: Readonly<Record<string, string>>;
  /** Storage technologies only: how a generated composition root connects
   *  to the technology's database (ADR 2026-067). `env` names the variable
   *  the connection URL is read from, once per compose function; each app
   *  runtime names a function and the module it is imported from, called
   *  with that URL, whose result every store of the technology receives
   *  (`drizzle` from `drizzle-orm/bun-sql` on Bun). The module's package
   *  must be pinned in that runtime's `appPins`. Absent: the database is a
   *  value constructed with no arguments (`new InMemoryDatabase()`). */
  readonly connect?: AppConnection;
  readonly description: string;
}

/** A storage technology's connection, per app runtime (ADR 2026-067). */
export interface AppConnection {
  readonly env: string;
  readonly runtimes: Readonly<Record<string, { readonly function: string; readonly from: string }>>;
}

const SCRIPT_NAME = /^[a-z][a-z0-9]*(?:[:-][a-z0-9]+)*$/;

function checkedScripts(value: unknown, where: string): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error(`${where} workspaceScripts must be a non-empty object of script name → command`);
  }
  const out: Record<string, string> = {};
  for (const name of Object.keys(value).sort()) {
    const command = (value as Record<string, unknown>)[name];
    if (!SCRIPT_NAME.test(name)) {
      throw new Error(`${where} workspaceScripts name '${name}' must be lowercase words joined by ':' or '-'`);
    }
    // eslint-disable-next-line no-control-regex
    if (typeof command !== "string" || command.trim() !== command || command === "" || /[\u0000-\u001f\u007f]/.test(command)) {
      throw new Error(`${where} workspaceScripts '${name}' must be a one-line command with no surrounding whitespace`);
    }
    out[name] = command;
  }
  return out;
}

function checkedPins(value: unknown, where: string): Pins {
  if (value === undefined) return { dependencies: {}, devDependencies: {} };
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "dependencies" && key !== "devDependencies")) {
    throw new Error(`${where} pins must be an object with only dependencies and devDependencies`);
  }
  const out: Record<string, Record<string, string>> = { dependencies: {}, devDependencies: {} };
  for (const [section, entries] of Object.entries(value as Record<string, unknown>)) {
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
      throw new Error(`${where} pins.${section} must be an object`);
    }
    for (const [name, version] of Object.entries(entries as Record<string, unknown>)) {
      if (!PACKAGE_NAME.test(name) || typeof version !== "string" || !EXACT_VERSION.test(version)) {
        throw new Error(`${where} pins.${section} entry '${name}' must be a package name pinned to an exact version`);
      }
      out[section]![name] = version;
    }
  }
  return { dependencies: out.dependencies!, devDependencies: out.devDependencies! };
}

function checkedAppPins(value: unknown, where: string): Record<string, Pins> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error(`${where} appPins must be a non-empty object of app runtime → pins`);
  }
  const out: Record<string, Pins> = {};
  for (const runtime of Object.keys(value).sort()) {
    if (!KEBAB.test(runtime)) throw new Error(`${where} appPins runtime '${runtime}' must be kebab-case`);
    out[runtime] = checkedPins((value as Record<string, unknown>)[runtime], `${where} appPins.${runtime}`);
  }
  return out;
}

/** A plain upper-case identifier: words of capitals and digits joined by single underscores (`DATABASE_URL`). */
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MODULE_SPECIFIER = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/** The package a bare module specifier resolves from: `drizzle-orm/bun-sql` → `drizzle-orm`. */
export const packageOfSpecifier = (specifier: string): string =>
  specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

function checkedConnect(value: unknown, appPins: Readonly<Record<string, Pins>> | undefined, where: string): AppConnection {
  const entry = strictObject(value, ["env", "runtimes"], `${where} connect`);
  if (typeof entry.env !== "string" || !ENV_NAME.test(entry.env)) {
    throw new Error(`${where} connect.env must be a plain upper-case identifier such as DATABASE_URL`);
  }
  const runtimes = strictObject(entry.runtimes, Object.keys(entry.runtimes ?? {}), `${where} connect.runtimes`);
  if (Object.keys(runtimes).length === 0) throw new Error(`${where} connect.runtimes must name at least one app runtime`);
  const out: Record<string, { function: string; from: string }> = {};
  for (const runtime of Object.keys(runtimes).sort()) {
    const named = `${where} connect.runtimes.${runtime}`;
    if (!KEBAB.test(runtime)) throw new Error(`${named}: the runtime must be kebab-case`);
    const spec = strictObject(runtimes[runtime], ["function", "from"], named);
    if (typeof spec.function !== "string" || !IDENTIFIER.test(spec.function)) throw new Error(`${named} needs a function name`);
    if (typeof spec.from !== "string" || !MODULE_SPECIFIER.test(spec.from)) throw new Error(`${named} needs a bare module specifier in from`);
    const pkg = packageOfSpecifier(spec.from);
    if (appPins?.[runtime]?.dependencies[pkg] === undefined) {
      throw new Error(`${named} imports from '${spec.from}', but appPins.${runtime}.dependencies does not pin '${pkg}'`);
    }
    out[runtime] = { function: spec.function, from: spec.from };
  }
  return { env: entry.env, runtimes: out };
}

function strictObject(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const unknownKey = Object.keys(value).find((key) => !keys.includes(key));
  if (unknownKey !== undefined) throw new Error(`${where} has an unknown field '${unknownKey}'`);
  return value as Record<string, unknown>;
}

/**
 * The composed packs' `adapterTechnologies`, sorted by id. Each contrib.json
 * entry is `{ id, direction, description, featureRole?, storage?, database?,
 * pins?, appPins?, workspaceScripts?, connect? }`: an in adapter declares `featureRole` and no
 * `storage`; an out adapter declares `storage` and no `featureRole`; a
 * storage technology declares `database: "value" | "type"`. Unknown
 * fields, a duplicate id across the composition, a pin that is not exact, and
 * a workspace script name that is malformed, empty-commanded or contributed
 * by two technologies are refused.
 */
export function adapterTechnologies(packs: readonly string[], packsDir = defaultPacksDir()): AdapterTechnology[] {
  const out: AdapterTechnology[] = [];
  const ids = new Set<string>();
  const scriptOwners = new Map<string, string>();
  for (const { pack, value } of contributionsByPack("adapterTechnologies", packs, packsDir)) {
    if (!Array.isArray(value)) throw new Error(`Selected pack '${pack}' adapterTechnologies must be an array`);
    for (const raw of value) {
      const where = `Selected pack '${pack}' adapterTechnologies entry`;
      const entry = strictObject(raw, ["id", "direction", "description", "featureRole", "storage", "database", "pins", "appPins", "workspaceScripts", "connect"], where);
      const { id, direction, description, featureRole, storage } = entry;
      if (typeof id !== "string" || !KEBAB.test(id)) throw new Error(`${where} needs a kebab-case id`);
      const named = `${where} '${id}'`;
      if (ids.has(id)) throw new Error(`${named} is contributed twice across the composition`);
      if (typeof description !== "string" || description.trim() === "") throw new Error(`${named} needs a description`);
      if (direction === "in") {
        if (typeof featureRole !== "string" || !/^[a-z][a-z0-9]*$/.test(featureRole) || RESERVED_ROLES.has(featureRole)) {
          throw new Error(`${named} needs a one-word lowercase featureRole that the naming table does not already use`);
        }
        if (storage !== undefined) throw new Error(`${named} is an in adapter and cannot declare storage`);
        if (entry.database !== undefined) throw new Error(`${named} is an in adapter and cannot declare a database`);
      } else if (direction === "out") {
        if (typeof storage !== "boolean") throw new Error(`${named} is an out adapter and must declare storage: true or false`);
        if (featureRole !== undefined) throw new Error(`${named} is an out adapter and cannot declare a featureRole`);
        if (storage && entry.database !== "value" && entry.database !== "type") {
          throw new Error(`${named} is a storage technology and must declare database: "value" (a class) or "type" (a type alias)`);
        }
        if (!storage && entry.database !== undefined) throw new Error(`${named} has no database and cannot declare one`);
      } else {
        throw new Error(`${named} needs direction 'in' or 'out'`);
      }
      const scripts = entry.workspaceScripts === undefined ? undefined : checkedScripts(entry.workspaceScripts, named);
      for (const name of Object.keys(scripts ?? {})) {
        const owner = scriptOwners.get(name);
        if (owner !== undefined) throw new Error(`${named} workspace script '${name}' is already contributed by '${owner}'`);
        scriptOwners.set(name, id);
      }
      if (entry.connect !== undefined && !(direction === "out" && storage === true)) {
        throw new Error(`${named} is not a storage technology and cannot declare connect`);
      }
      const appPins = entry.appPins === undefined ? undefined : checkedAppPins(entry.appPins, named);
      const connect = entry.connect === undefined ? undefined : checkedConnect(entry.connect, appPins, named);
      ids.add(id);
      out.push({
        pack, id, direction, description,
        ...(direction === "in" ? { featureRole: featureRole as string } : {}),
        storage: direction === "out" && storage === true,
        ...(direction === "out" && storage === true ? { database: entry.database as "value" | "type" } : {}),
        pins: checkedPins(entry.pins, named),
        ...(appPins === undefined ? {} : { appPins }),
        ...(scripts === undefined ? {} : { workspaceScripts: scripts }),
        ...(connect === undefined ? {} : { connect }),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** One file a workspace template seeds (ADR 2026-061). */
export interface WorkspaceTemplateFile {
  /** Workspace-relative target, e.g. `src/server/main.ts`. */
  readonly path: string;
  /** Pack-relative source, e.g. `templates/web/main.ts`. */
  readonly source: string;
  readonly mode: EmitMode;
}

/** How one kind of workspace is laid out and what it seeds (ADR 2026-061). */
export interface WorkspaceTemplate {
  readonly pack: string;
  /** Kebab-case; the value in a TN's `workspaces:` map, or `context`. */
  readonly kind: string;
  /** The directory workspaces of this kind sit in, e.g. `apps`. */
  readonly root: string;
  /** Pack-relative JSON manifest template (no `name`: the generator sets it). */
  readonly manifest: string;
  /** Kebab-case: what the app's composition root runs on (`bun`, `node`).
   *  It selects the `appPins` the app takes. Every app template declares
   *  one; the context template does not. */
  readonly runtime?: string;
  /** Sorted by path. */
  readonly files: readonly WorkspaceTemplateFile[];
  readonly description: string;
}

/**
 * The composed packs' `workspaceTemplates`, sorted by kind. Each contrib.json
 * value is an object keyed by kind: `{ root, manifest, description, runtime?,
 * files? }`,
 * where `files` maps a workspace-relative path to `{ source, mode }`. Every
 * pack-relative source must exist; a kind contributed twice, an unknown
 * field, `..`, an absolute path, or a template file named `package.json` (the
 * manifest has its own field) is refused. Template text may use only the
 * placeholders `{{scope}}`, `{{name}}` and `{{package}}` (TN-26-012); the
 * workspace generator refuses any other.
 */
export function workspaceTemplates(packs: readonly string[], packsDir = defaultPacksDir()): WorkspaceTemplate[] {
  const out: WorkspaceTemplate[] = [];
  const kinds = new Set<string>();
  for (const { pack, value } of contributionsByPack("workspaceTemplates", packs, packsDir)) {
    const byKind = strictObject(value, Object.keys(value ?? {}), `Selected pack '${pack}' workspaceTemplates`);
    const packFile = (path: unknown, where: string): string => {
      if (typeof path !== "string" || !PACK_FILE.test(path) || path.split("/").some((s) => s === "." || s === "..")) {
        throw new Error(`${where} must be a pack-relative lowercase path`);
      }
      if (!existsSync(join(packsDir, pack, path))) throw new Error(`${where} names '${path}', which the pack does not ship`);
      return path;
    };
    for (const [kind, raw] of Object.entries(byKind)) {
      const where = `Selected pack '${pack}' workspace template '${kind}'`;
      if (!KEBAB.test(kind)) throw new Error(`${where} needs a kebab-case kind`);
      if (kinds.has(kind)) throw new Error(`${where} is contributed twice across the composition`);
      const entry = strictObject(raw, ["root", "manifest", "description", "runtime", "files"], where);
      if (entry.runtime !== undefined && (typeof entry.runtime !== "string" || !KEBAB.test(entry.runtime))) {
        throw new Error(`${where} runtime must be kebab-case`);
      }
      if (typeof entry.root !== "string" || !KEBAB.test(entry.root)) throw new Error(`${where} needs a one-segment kebab-case root`);
      if (typeof entry.description !== "string" || entry.description.trim() === "") throw new Error(`${where} needs a description`);
      const manifest = packFile(entry.manifest, `${where} manifest`);
      if (!manifest.endsWith(".json")) throw new Error(`${where} manifest must be a .json file`);
      const files: WorkspaceTemplateFile[] = [];
      const rawFiles = entry.files === undefined ? {} : strictObject(entry.files, Object.keys(entry.files ?? {}), `${where} files`);
      for (const [path, spec] of Object.entries(rawFiles)) {
        const fileWhere = `${where} file '${path}'`;
        if (!WORKSPACE_FILE.test(path) || path.split("/").some((s) => s === "." || s === "..") ||
            path.split("/").at(-1)!.toLowerCase() === "package.json") {
          throw new Error(`${fileWhere} must be a workspace-relative path other than package.json`);
        }
        const file = strictObject(spec, ["source", "mode"], fileWhere);
        if (file.mode !== "skeleton" && file.mode !== "generated") throw new Error(`${fileWhere} needs mode 'skeleton' or 'generated'`);
        files.push({ path, source: packFile(file.source, `${fileWhere} source`), mode: file.mode });
      }
      kinds.add(kind);
      out.push({
        pack, kind, root: entry.root, manifest, description: entry.description,
        ...(entry.runtime === undefined ? {} : { runtime: entry.runtime as string }),
        files: files.sort((a, b) => a.path.localeCompare(b.path)),
      });
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * The ts pack. Depends on nothing — it is the root of the TypeScript family —
 * and contributes nothing: its own rules are its gates' base config.
 */
export const tsPack = definePack({
  name: TS_PACK,
  dependsOnPacks: [],
  defines: [lintSrcRules, contractPurityOverrides, deliverChecks, artifactGenerators, skeletonEmitters, phaseTestPolicies, testObligations],
});
