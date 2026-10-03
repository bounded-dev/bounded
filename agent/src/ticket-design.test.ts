import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ACTIVE_TICKET_RELATIVE, activeTicketDesign, activeTicketNumber, designNotePath, readActiveTicketFile,
  resolveTicketDesign, ticketWriteScope,
} from "./ticket-design.ts";
import { writeProjectPacks } from "./project-composition.ts";
import { contractFileSuffixes, hasContractSuffix } from "./pack-contrib.ts";
import { computeManifest, runChecksumGate } from "../packs/ts/scripts/checksum-gate.ts";
import { readReviewed, runRecordDesignReview } from "../packs/ts/scripts/design-review.ts";
import { classifyReviewFreshness } from "../packs/ts/scripts/design-gate.ts";
import { readGuardLog } from "./guard-log.ts";
import { decide } from "./path-policy.ts";
import { evaluatePathGate } from "./path-gate.ts";
import { PI_COMMISSIONS } from "../hosts/pi/extensions/lib/commissions.ts";

// No installed pack contributes source roots yet (the hexagonal layout pack
// does, ADR 2026-063), so this suite gives the composed ts project the
// hexagonal context roots. The real reader still runs first, so an unreadable
// composition still throws exactly as it would.
vi.mock("./pack-contrib.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pack-contrib.ts")>();
  return {
    ...actual,
    sourceRoots: (cwd: string, packsDir?: string): string[] => {
      actual.sourceRoots(cwd, packsDir);
      return ["contexts/*/src"];
    },
  };
});

/** The layout decide() judges the architect's writes with, as a host passes it. */
function layoutCtx(root: string) {
  return {
    cwd: root,
    sourceRoots: ["contexts/*/src"],
    contractGlobs: ["contexts/*/src/**/*.contract.ts"],
    testSuffixes: [".test.ts"],
    generatedGlobs: [],
  };
}

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-ticket-design-"));
  roots.push(root);
  mkdirSync(join(root, "docs/tn"), { recursive: true });
  mkdirSync(join(root, "contexts/notes/src"), { recursive: true });
  writeFileSync(join(root, "docs/tn/README.md"), "# Technical Notes\n");
  writeProjectPacks(root, ["ts"]);
  for (const n of [24, 25]) {
    writeFileSync(join(root, `docs/tn/TN-${n}.md`),
      `---\nissue: ${n}\nstatus: active\ncontracts:\n  - contexts/notes/src/t${n}.contract.ts\n---\n\n# Ticket ${n}\n`);
    writeFileSync(join(root, `contexts/notes/src/t${n}.contract.ts`), `export interface T${n} {}\n`);
  }
  return root;
}

describe("ticket-numbered design", () => {
  test("requires an active issue number and prevents overlapping ownership", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", undefined);
    expect(() => activeTicketDesign(root)).toThrow(
      "no active ticket — select the current issue with the team lead (it records .bounded/active-ticket) " +
      "or set BOUNDED_TICKET=<issue number>");
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(activeTicketDesign(root)?.note).toBe("docs/tn/TN-24.md");
    writeFileSync(join(root, "docs/tn/TN-25.md"),
      "---\r\nissue: 25\r\nstatus: active\r\ncontracts:\r\n  - contexts/notes/src/t24.contract.ts\r\n---\r\n");
    // Neither ticket froze it, so neither can be named its owner (review M2).
    expect(() => activeTicketDesign(root)).toThrow(
      "contract contexts/notes/src/t24.contract.ts is claimed by ticket #24 and ticket #25, and no single frozen " +
      "design settles which owns it: return it to the team lead to decide; never edit another ticket's design note");
    writeFileSync(join(root, "docs/tn/TN-25.md"),
      "---\nissue: 25\nstatus: superseded\ncontracts:\n  - contexts/notes/src/t24.contract.ts\n---\n\nSuperseded by [TN-24](TN-24.md).\n");
    expect(activeTicketDesign(root)?.ticket).toBe("24");
  });

  test("architect writes only its declared contracts, including before creation", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    const scope = ticketWriteScope(root)!;
    expect(scope.contractSuffixes).toEqual([".contract.ts"]);
    const ctx = { ...layoutCtx(root), ticketScope: scope };
    expect(decide("architect", "write", { path: "contexts/notes/src/t24.contract.ts" }, ctx).allow).toBe(true);
    expect(decide("architect", "write", { path: "contexts/notes/src/t25.contract.ts" }, ctx).allow).toBe(false);
    expect(decide("architect", "write", { path: "contexts/notes/src/T24.contract.ts" }, ctx).allow).toBe(false);
    expect(evaluatePathGate({ role: "architect", toolName: "write", input: { path: "contexts/notes/src/t25.contract.ts" }, cwd: root })?.reason)
      .toBe("path-gate: contract contexts/notes/src/t25.contract.ts belongs to ticket #25: " +
        "after the active ticket is delivered, change it in a run on ticket #25; never edit another ticket's design note");
    expect(evaluatePathGate({ role: "architect", toolName: "write", input: { path: "contexts/notes/src/fresh.contract.ts" }, cwd: root })?.reason)
      .toBe("path-gate: contract 'contexts/notes/src/fresh.contract.ts' is not owned by ticket #24; " +
        "list it under `contracts:` in the front matter of docs/tn/TN-24.md, then write it");
    expect(decide("architect", "write", { path: "docs/tn/TN-25.md" }, ctx).allow).toBe(false);
    expect(decide("architect", "write", { path: "spec.md" }, ctx).allow).toBe(false);
    writeFileSync(join(root, "docs/tn/TN-24.md"),
      "---\nissue: 24\nstatus: draft\ncontracts:\n  - contexts/notes/src/t24.contract.ts\n  - contexts/notes/src/new.contract.ts\n---\n");
    expect(decide("architect", "write", { path: "contexts/notes/src/new.contract.ts" },
      { ...layoutCtx(root), ticketScope: ticketWriteScope(root) }).allow).toBe(true);
  });

  test("two tickets freeze and review only their own note and contracts", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(Object.keys(computeManifest(root).files)).toEqual(["contexts/notes/src/t24.contract.ts"]);
    expect(runRecordDesignReview(root, []).code).toBe(0);
    expect(runChecksumGate(root, true).code).toBe(0);
    const first = readReviewed(root);
    if (!first.ok) throw new Error(first.error);
    expect(Object.keys(first.reviewed)).toEqual(["docs/tn/TN-24.md", "contexts/notes/src/t24.contract.ts", "composition:ts"]);
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(runRecordDesignReview(root, []).code).toBe(0);
    expect(runChecksumGate(root, true).code).toBe(0);
    expect(runChecksumGate(root, false).code).toBe(0);
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "contexts/notes/src/t25.contract.ts"), "export interface T25 { changed: true }\n");
    expect(runChecksumGate(root, false).code).toBe(0);
    expect(classifyReviewFreshness(readGuardLog(root), first.reviewed, "24").state).toBe("fresh");
    writeFileSync(join(root, "docs/tn/TN-24.md"),
      "---\nissue: 24\nstatus: active\ncontracts:\n  - contexts/notes/src/t24.contract.ts\n---\n\n# Revised ticket\n");
    expect(runChecksumGate(root, false).code).toBe(1);
  });
});

// A contract another ticket owns is changed by a run on THAT ticket, once the
// active ticket is delivered (the lead cannot switch tickets mid-run). The
// owner is the ticket whose frozen design holds the contract; when that does
// not settle it, the refusal names every claimant. It never suggests editing
// a design note: a delivered ticket's note is its frozen record.
describe("a contract another ticket owns names its owner and the change run", () => {
  const route = (path: string, owner: string, run = "change run", active = true): string =>
    `contract ${path} belongs to ticket #${owner}: ${active ? "after the active ticket is delivered, " : ""}` +
    `change it in a ${run} on ticket #${owner}; never edit another ticket's design note`;
  const contested = (path: string, a: string, b: string): string =>
    `contract ${path} is claimed by ticket #${a} and ticket #${b}, and no single frozen design settles which owns it: ` +
    "return it to the team lead to decide; never edit another ticket's design note";
  const refusal = (decision: ReturnType<typeof decide>): string => (decision.allow ? "" : decision.reason);
  const gate = (root: string, path: string, toolName = "write"): string | undefined =>
    evaluatePathGate({ role: "architect", toolName, input: { path }, cwd: root })?.reason;
  /** Freeze `ticket`'s design for real: its manifest holds its contracts. */
  const freeze = (root: string, ticket: string): void => {
    vi.stubEnv("BOUNDED_TICKET", ticket);
    expect(runRecordDesignReview(root, []).code).toBe(0);
    expect(runChecksumGate(root, true).code).toBe(0);
  };
  /** A frozen manifest written directly, for states the gates would refuse to reach. */
  const manifest = (root: string, ticket: string, paths: readonly string[]): void => {
    mkdirSync(join(root, `.bounded/tickets/${ticket}`), { recursive: true });
    writeFileSync(join(root, `.bounded/tickets/${ticket}/contract-checksums.json`),
      JSON.stringify({ files: Object.fromEntries(paths.map((path) => [path, "0"])) }));
  };
  const T24 = "contexts/notes/src/t24.contract.ts";
  const T25 = "contexts/notes/src/t25.contract.ts";
  const SHARED = "contexts/notes/src/shared.contract.ts";
  const claimT24 = "---\nissue: 25\nstatus: draft\ncontracts:\n  - contexts/notes/src/t24.contract.ts\n  - contexts/notes/src/t25.contract.ts\n---\n";

  // Ticket #24 froze the contract, so it is #24's; #25 is told to wait for its
  // own delivery, then change it in a change run on #24.
  test("two tickets claiming one contract: the design refusal names the other ticket", () => {
    const root = project();
    freeze(root, "24");
    vi.stubEnv("BOUNDED_TICKET", "25");
    writeFileSync(join(root, "docs/tn/TN-25.md"), claimT24);
    const state = resolveTicketDesign(root);
    expect(state).toEqual({ kind: "refused", ticket: "25", reason: route(T24, "24") });
    expect(ticketWriteScope(root)!.error).toBe(route(T24, "24"));
    const reason = gate(root, T25);
    expect(reason).toBe(`path-gate: ${route(T24, "24")}`);
    for (const text of [state.kind === "refused" ? state.reason : "", reason ?? ""]) {
      expect(text).not.toMatch(/both own|list it under|contracts:|front matter|TN-\d+\.md/);
    }
  });

  test("review repro: two tickets claiming a contract neither froze are both named", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "25");
    writeFileSync(join(root, "docs/tn/TN-25.md"), claimT24);
    // Before the fix: "belongs to ticket #24", though nothing makes it #24's.
    expect(resolveTicketDesign(root)).toEqual({ kind: "refused", ticket: "25", reason: contested(T24, "24", "25") });
    expect(ticketWriteScope(root)!.error).toBe(contested(T24, "24", "25"));
    expect(gate(root, T25)).toBe(`path-gate: ${contested(T24, "24", "25")}`);
  });

  test("review repro: an unfrozen claim never takes a contract from the ticket that froze it", () => {
    const root = project();
    freeze(root, "24");
    writeFileSync(join(root, "docs/tn/TN-25.md"), claimT24);
    vi.stubEnv("BOUNDED_TICKET", "24");
    // Before the fix: "contract ... belongs to ticket #25", the wrong owner.
    expect(resolveTicketDesign(root)).toMatchObject({ kind: "ready", design: { ticket: "24" } });
    expect(ticketWriteScope(root)).toMatchObject({ ticket: "24", contracts: [T24] });
    expect(ticketWriteScope(root)!.error).toBeUndefined();
  });

  test("two frozen designs holding one contract: the refusal names both", () => {
    const root = project();
    manifest(root, "24", [T24]);
    manifest(root, "25", [T24, T25]);
    vi.stubEnv("BOUNDED_TICKET", "25");
    writeFileSync(join(root, "docs/tn/TN-25.md"), claimT24);
    expect(resolveTicketDesign(root)).toEqual({ kind: "refused", ticket: "25", reason: contested(T24, "24", "25") });
  });

  test("the path gate names the owning ticket of a contract the active note does not list", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    const unfrozen = gate(root, T25, "edit");
    expect(unfrozen).toBe(`path-gate: ${route(T25, "25", "run")}`);
    expect(unfrozen).not.toMatch(/list it under|front matter/);
    freeze(root, "25");
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(gate(root, T25, "edit")).toBe(`path-gate: ${route(T25, "25")}`);
  });

  test("the owner is read from the other ticket's note, for a contract not created yet", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "docs/tn/TN-25.md"),
      "---\nissue: 26\nstatus: draft\ncontracts:\n  - contexts/notes/src/shared.contract.ts\n---\n");
    const ctx = { ...layoutCtx(root), ticketScope: ticketWriteScope(root) };
    expect(refusal(decide("architect", "write", { path: SHARED }, ctx)))
      .toBe(`path-gate: ${route(SHARED, "25", "run")}`);
  });

  test("two other tickets claiming one contract: the path gate names both", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    for (const n of ["25", "26"]) {
      writeFileSync(join(root, `docs/tn/TN-${n}.md`),
        `---\nissue: ${n}\nstatus: draft\ncontracts:\n  - contexts/notes/src/shared.contract.ts\n---\n`);
    }
    expect(gate(root, SHARED)).toBe(`path-gate: ${contested(SHARED, "25", "26")}`);
    manifest(root, "26", [SHARED]);
    expect(gate(root, SHARED)).toBe(`path-gate: ${route(SHARED, "26")}`);
  });

  test("a superseded note owns nothing", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "docs/tn/TN-25.md"),
      "---\nissue: 25\nstatus: superseded\ncontracts:\n  - contexts/notes/src/t25.contract.ts\n---\n\nSuperseded by [TN-24](TN-24.md).\n");
    expect(evaluatePathGate({ role: "architect", toolName: "write", input: { path: "contexts/notes/src/t25.contract.ts" }, cwd: root })?.reason)
      .toBe("path-gate: contract 'contexts/notes/src/t25.contract.ts' is not owned by ticket #24; " +
        "list it under `contracts:` in the front matter of docs/tn/TN-24.md, then write it");
  });

  test("writing another ticket's design note is refused with the same route", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(evaluatePathGate({ role: "architect", toolName: "write", input: { path: "docs/tn/TN-25.md" }, cwd: root })?.reason)
      .toBe("path-gate: architect may write only ticket #24's TN; docs/tn/TN-25.md belongs to ticket #25: " +
        "after the active ticket is delivered, change it in a run on ticket #25; never edit another ticket's design note");
  });

  test("with no ticket selected, another ticket's note is refused without naming an active ticket", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", undefined);
    expect(gate(root, "docs/tn/TN-25.md"))
      .toBe("path-gate: no ticket is selected; docs/tn/TN-25.md belongs to ticket #25: " +
        "change it in a run on ticket #25; never edit another ticket's design note");
  });
});

function selectFile(root: string, content: string): void {
  mkdirSync(join(root, ".bounded"), { recursive: true });
  writeFileSync(join(root, ".bounded/installation.json"), "{}\n");
  writeFileSync(join(root, ACTIVE_TICKET_RELATIVE), content);
}

describe("active ticket selection", () => {
  test("reads the lead's selection file in a project-local installation", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", undefined);
    selectFile(root, "24\n");
    expect(readActiveTicketFile(root)).toEqual({ kind: "selected", ticket: "24" });
    expect(activeTicketNumber(root)).toBe("24");
    expect(activeTicketDesign(root)?.note).toBe("docs/tn/TN-24.md");
  });

  test("an explicit BOUNDED_TICKET takes precedence over the file", () => {
    const root = project();
    selectFile(root, "24\n");
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(activeTicketNumber(root)).toBe("25");
    vi.stubEnv("BOUNDED_TICKET", "x");
    expect(activeTicketNumber(root)).toBeUndefined();
    expect(() => designNotePath(root)).toThrow("BOUNDED_TICKET='x' is not a positive issue number");
    vi.stubEnv("BOUNDED_TICKET", "");
    expect(activeTicketNumber(root)).toBe("24");
  });

  test("the file is ignored without installation.json", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", undefined);
    selectFile(root, "24\n");
    rmSync(join(root, ".bounded/installation.json"));
    expect(activeTicketNumber(root)).toBeUndefined();
  });

  test("a malformed or non-regular selection selects nothing, precisely", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", undefined);
    expect(readActiveTicketFile(root)).toEqual({ kind: "absent" });
    selectFile(root, "twenty\n");
    expect(readActiveTicketFile(root)).toEqual({ kind: "invalid", reason: ".bounded/active-ticket is malformed" });
    expect(activeTicketNumber(root)).toBeUndefined();
    expect(() => activeTicketDesign(root)).toThrow(/^\.bounded\/active-ticket is malformed; no active ticket/);
    rmSync(join(root, ACTIVE_TICKET_RELATIVE));
    writeFileSync(join(root, ".bounded/elsewhere"), "24\n");
    symlinkSync(join(root, ".bounded/elsewhere"), join(root, ACTIVE_TICKET_RELATIVE));
    expect(readActiveTicketFile(root).kind).toBe("invalid");
    expect(activeTicketNumber(root)).toBeUndefined();
  });
});

describe("design resolution tolerates legitimate states and scopes refusals", () => {
  test("a selected ticket whose note is not written yet is the architect's starting point", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "26");
    expect(resolveTicketDesign(root)).toEqual({ kind: "unwritten", ticket: "26", note: "docs/tn/TN-26.md" });
    expect(designNotePath(root)).toBe("docs/tn/TN-26.md");
    const scope = ticketWriteScope(root)!;
    expect(scope).toMatchObject({ ticket: "26", contracts: [], contractSuffixes: [".contract.ts"], frozenTickets: [] });
    expect(scope.error).toBeUndefined();
    // Other tickets' contracts, so a refusal can name their owner.
    expect(Object.keys(scope.foreign ?? {})).toEqual(["contexts/notes/src/t24.contract.ts", "contexts/notes/src/t25.contract.ts"]);
    expect(scope.foreign?.["contexts/notes/src/t25.contract.ts"]).toContain("belongs to ticket #25");
    expect(() => activeTicketDesign(root)).toThrow("ticket #26 needs docs/tn/TN-26.md before design review or freeze");
    // A scout may help before the note exists; a worker may not.
    expect(evaluatePathGate({ role: "architect", toolName: "subagent", commissions: PI_COMMISSIONS, input: { agent: "scout", task: "look" }, cwd: root }))
      .toBeUndefined();
    expect(evaluatePathGate({ role: "architect", toolName: "subagent", commissions: PI_COMMISSIONS, input: { agent: "builder", task: "go" }, cwd: root })
      ?.reason).toMatch(/^phase-gate: cannot commission the builder/);
  });

  test("another ticket's own hygiene never blocks this ticket", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "docs/tn/TN-25.md"), "---\nissue: 99\nstatus: superseded\n---\n\nNo successor link.\n");
    writeFileSync(join(root, "docs/tn/TN-27.md"), "---\nissue: 27\nstatus: bogus\ncontracts:\n  - contexts/notes/src/t27.contract.ts\n---\n");
    expect(activeTicketDesign(root)?.ticket).toBe("24");
    expect(ticketWriteScope(root)?.error).toBeUndefined();
  });

  test("an unreadable sibling refuses ownership checks precisely, and only where ownership matters", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "docs/tn/TN-25.md"), "# no front matter\n");
    const reason = "docs/tn/TN-25.md has no readable TN front matter, so ticket #24's contract ownership cannot be " +
      "checked — ask the team lead to repair docs/tn/TN-25.md (it belongs to ticket #25, not #24)";
    expect(resolveTicketDesign(root)).toEqual({ kind: "refused", ticket: "24", reason });
    expect(() => activeTicketDesign(root)).toThrow(reason);
    expect(ticketWriteScope(root)?.error).toBe(reason);
    expect(decide("architect", "write", { path: "contexts/notes/src/t24.contract.ts" }, { cwd: root, ticketScope: ticketWriteScope(root) }))
      .toEqual({ allow: false, reason: `path-gate: ${reason}` });
    expect(decide("architect", "write", { path: "docs/tn/TN-24.md" }, { ...layoutCtx(root), ticketScope: ticketWriteScope(root) }).allow)
      .toBe(true);
    expect(resolveTicketDesign(root, { siblings: "ignore" }).kind).toBe("ready");
    writeFileSync(join(root, "docs/tn/TN-25.md"), "---\nissue: 25\nstatus: active\ncontracts:\n  contexts/notes/src/t25.contract.ts\n---\n");
    expect(() => activeTicketDesign(root)).toThrow(/^docs\/tn\/TN-25.md has an unreadable contracts: list/);
  });

  test("a design problem becomes the refusal a gated spawn reads, not a hook error", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "docs/tn/TN-24.md"), "---\nissue: 24\nstatus: active\ncontracts:\n  - contexts/notes/src/gone.contract.ts\n---\n");
    expect(evaluatePathGate({ role: "architect", toolName: "subagent", commissions: PI_COMMISSIONS, input: { agent: "builder", task: "go" }, cwd: root })
      ?.reason).toBe("phase-gate: cannot commission the builder — docs/tn/TN-24.md names missing contract 'contexts/notes/src/gone.contract.ts'");
    expect(evaluatePathGate({ role: "architect", toolName: "subagent", commissions: PI_COMMISSIONS, input: { agent: "scout", task: "look" }, cwd: root }))
      .toBeUndefined();
  });

  test("a gate that cannot evaluate refuses with a reason instead of throwing", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    rmSync(join(root, ".bounded/composed-packs.json"));
    const result = evaluatePathGate({ role: "architect", toolName: "subagent", commissions: PI_COMMISSIONS, input: { agent: "builder", task: "go" }, cwd: root });
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/^phase-gate: .*bounded compose/);
  });
});

describe("contract recognition is a composed pack's contribution", () => {
  function packs(manifests: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "bounded-contract-packs-"));
    roots.push(dir);
    for (const [name, manifest] of Object.entries(manifests)) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "contrib.json"), manifest);
    }
    return dir;
  }

  test("a composition without a contributing pack recognises no contract", () => {
    const root = project();
    const dir = packs({ plain: "{}", typed: '{"contractFileSuffixes":[".contract.ts"]}' });
    writeProjectPacks(root, ["plain"]);
    expect(contractFileSuffixes(root, dir)).toEqual([]);
    expect(hasContractSuffix("contexts/notes/src/t24.contract.ts", contractFileSuffixes(root, dir))).toBe(false);
    writeProjectPacks(root, ["plain", "typed"]);
    expect(hasContractSuffix("contexts/notes/src/t24.contract.ts", contractFileSuffixes(root, dir))).toBe(true);
    expect(() => contractFileSuffixes(root, packs({ bad: '{"contractFileSuffixes":["contract"]}' })))
      .toThrow(/Selected pack|dotted filename suffix/);
  });

  test("the architect's ownership check follows the scope's suffixes, not a core literal", () => {
    const root = project();
    const scope = { ticket: "24", contracts: [], contractSuffixes: [".design.x"] };
    expect(decide("architect", "write", { path: "contexts/notes/src/a.design.x" }, { cwd: root, ticketScope: scope }).allow).toBe(false);
    const unknown = { ticket: "24", contracts: [], contractSuffixes: [], error: "cannot tell which files are contracts" };
    expect(decide("architect", "write", { path: "contexts/notes/src/t24.contract.ts" }, { cwd: root, ticketScope: unknown }))
      .toEqual({ allow: false, reason: "path-gate: cannot tell which files are contracts" });
  });

  test("a note naming a contract with no readable composition is refused precisely", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    rmSync(join(root, ".bounded/composed-packs.json"));
    expect(() => activeTicketDesign(root)).toThrow(/^cannot tell which files are contracts: Cannot read project composition/);
    expect(ticketWriteScope(root)).toMatchObject({ ticket: "24", contracts: [], contractSuffixes: [] });
  });
});

describe("a contract path must lie under a composed source root (ADR 2026-056)", () => {
  const note = (contracts: string[], extra = ""): string =>
    `---\nissue: 24\nstatus: draft\ncontracts:\n${contracts.map((c) => `  - ${c}\n`).join("")}${extra}---\n`;

  test.each([
    ["src/t24.contract.ts", "outside every source root (contexts/*/src)"],
    ["contexts/notes/t24.contract.ts", "outside every source root"],
    ["contexts/notes/src", "outside every source root"],
    ["docs/t24.contract.ts", "outside every source root"],
    ["t24.contract.ts", "unsafe contract path"],
    ["contexts/notes/src/../src/t24.contract.ts", "unsafe contract path"],
    ["contexts/notes/src/./t24.contract.ts", "unsafe contract path"],
    ["/abs/contexts/notes/src/t24.contract.ts", "unsafe contract path"],
    ["contexts/notes/src/t24.ts", "is not a contract file"],
  ])("%s is refused (%s)", (path, why) => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "docs/tn/TN-24.md"), note([path]));
    expect(ticketWriteScope(root)?.error).toContain(why);
  });

  test("a case-varied root still counts as the root", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "docs/tn/TN-24.md"), note(["Contexts/Notes/SRC/t24.contract.ts"]));
    expect(ticketWriteScope(root)?.error).toBeUndefined();
  });

  test("an unreadable composition refuses the note rather than guessing a root", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeProjectPacks(root, ["missing-pack"]);
    expect(() => activeTicketDesign(root)).toThrow(/^cannot tell which files are contracts/);
  });
});

describe("the workspaces: front matter (TN-26-012 §9)", () => {
  const withWorkspaces = (block: string): string =>
    `---\nissue: 24\nstatus: active\ncontracts:\n  - contexts/notes/src/t24.contract.ts\n${block}---\n`;
  const design = (block: string) => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "docs/tn/TN-24.md"), withWorkspaces(block));
    return resolveTicketDesign(root);
  };

  test("absent is an empty map, and so is a bare workspaces:", () => {
    expect(design("")).toMatchObject({ kind: "ready", design: { workspaces: {} } });
    expect(design("workspaces:\n")).toMatchObject({ kind: "ready", design: { workspaces: {} } });
  });

  test("block form maps each directory to a kind", () => {
    expect(design("workspaces:\n  apps/web: web\n  apps/mcp: mcp\n  apps/lambdas: lambda-node\n")).toMatchObject({
      kind: "ready",
      design: { workspaces: { "apps/web": "web", "apps/mcp": "mcp", "apps/lambdas": "lambda-node" } },
    });
  });

  test("the block ends at the first unindented line", () => {
    expect(design("workspaces:\n  apps/web: web\nsummary: x\n")).toMatchObject({
      kind: "ready", design: { workspaces: { "apps/web": "web" } },
    });
  });

  test.each([
    ["workspaces: {apps/web: web}\n", "block-form"],
    ["workspaces: []\n", "block-form"],
    ["workspaces:\nworkspaces:\n", "block-form"],
    ["workspaces:\n  apps/web: web\n  apps/web: api\n", "twice"],
    ["workspaces:\n  apps/Web: web\n", "invalid workspaces: entry"],
    ["workspaces:\n  apps/web: Web\n", "invalid workspaces: entry"],
    ["workspaces:\n  apps/web:web\n", "invalid workspaces: entry"],
    ["workspaces:\n    apps/web: web\n", "invalid workspaces: entry"],
    ["workspaces:\n  - apps/web\n", "invalid workspaces: entry"],
    ["workspaces:\n  ../web: web\n", "invalid workspaces: entry"],
    ["workspaces:\n  /apps/web: web\n", "invalid workspaces: entry"],
    ["workspaces:\n  apps/web/: web\n", "invalid workspaces: entry"],
    ["workspaces:\n  apps/web: web # the site\n", "invalid workspaces: entry"],
    ["workspaces:\n  apps//web: web\n", "invalid workspaces: entry"],
    ["workspaces:\n  apps/web: web-\n", "invalid workspaces: entry"],
  ])("%j makes the note invalid (%s)", (block, why) => {
    const state = design(block);
    expect(state.kind).toBe("refused");
    if (state.kind === "refused") expect(state.reason).toContain(why);
  });
});

describe("a later ticket takes a delivered ticket's contract", () => {
  const c = (name: string): string => `contexts/notes/src/${name}.contract.ts`;
  const t24 = c("t24");
  const t24b = c("t24b");
  const t25 = c("t25");

  /** Write TN-<n> with its `contracts:` and optional `takes:` lists, and create
   *  every listed contract file. */
  function writeNote(root: string, n: number, options: {
    contracts: string[]; takes?: string[]; status?: string; body?: string;
  }): void {
    const takes = options.takes === undefined ? "" : `takes:\n${options.takes.map((t) => `  - ${t}\n`).join("")}`;
    writeFileSync(join(root, `docs/tn/TN-${n}.md`),
      `---\nissue: ${n}\nstatus: ${options.status ?? "active"}\ncontracts:\n` +
      `${options.contracts.map((p) => `  - ${p}\n`).join("")}${takes}---\n\n${options.body ?? `# Ticket ${n}\n`}`);
    for (const path of options.contracts) writeFileSync(join(root, path), "export interface X {}\n");
  }

  function abandon(root: string, n: number): void {
    mkdirSync(join(root, `.bounded/tickets/${n}`), { recursive: true });
    writeFileSync(join(root, `.bounded/tickets/${n}/abandoned`),
      '{"archive":"guard-log-x.jsonl","at":"2026-10-03T00:00:00Z"}\n');
  }

  /** TN-24 lists t24 and t24b; TN-25 lists t24 and t25 and takes t24 from TN-24. */
  function taken(): string {
    const root = project();
    writeNote(root, 24, { contracts: [t24, t24b] });
    writeNote(root, 25, { contracts: [t24, t25], takes: [`${t24} from TN-24`] });
    return root;
  }

  test("the taker owns a contract it takes, and may write it", () => {
    const root = taken();
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(activeTicketDesign(root)?.contracts).toEqual([t24, t25].sort());
    expect(ticketWriteScope(root)?.error).toBeUndefined();
    expect(decide("architect", "write", { path: t24 }, { ...layoutCtx(root), ticketScope: ticketWriteScope(root) }).allow)
      .toBe(true);
    expect(evaluatePathGate({ role: "architect", toolName: "write", input: { path: t24 }, cwd: root })).toBeUndefined();
  });

  test("the taker's review and freeze cover the taken contract", () => {
    const root = taken();
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(runRecordDesignReview(root, []).code).toBe(0);
    expect(runChecksumGate(root, true).code).toBe(0);
    expect(Object.keys(computeManifest(root).files)).toContain(t24);
    const reviewed = readReviewed(root);
    if (!reviewed.ok) throw new Error(reviewed.error);
    expect(Object.keys(reviewed.reviewed)).toContain(t24);
  });

  test("the giving note is left as written and no longer owns the contract", () => {
    const root = taken();
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(activeTicketDesign(root)?.contracts).toEqual([t24b]);
    expect(resolveTicketDesign(root, { siblings: "ignore" })).toMatchObject({ kind: "ready", design: { contracts: [t24b] } });
    expect(Object.keys(computeManifest(root).files)).toEqual([t24b]);
    const ctx = { ...layoutCtx(root), ticketScope: ticketWriteScope(root) };
    const refused = decide("architect", "write", { path: t24 }, ctx);
    expect(refused.allow).toBe(false);
    expect(refused.reason).toMatch(/TN-25/);
    expect(decide("architect", "write", { path: t24b }, ctx).allow).toBe(true);
  });

  test("a take must name a contract listed under contracts:", () => {
    const root = project();
    writeNote(root, 24, { contracts: [t24] });
    writeNote(root, 25, { contracts: [t25], takes: [`${t24} from TN-24`] });
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(() => activeTicketDesign(root)).toThrow(/takes .*t24\.contract\.ts.*contracts:/);
  });

  test("a take must cite a note that lists the contract", () => {
    const root = project();
    writeNote(root, 24, { contracts: [t24] });
    writeNote(root, 26, { contracts: [c("t26")] });
    writeNote(root, 25, { contracts: [t24, t25], takes: [`${t24} from TN-26`] });
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(() => activeTicketDesign(root)).toThrow(/TN-26\.md does not list/);
    writeNote(root, 25, { contracts: [t24, t25], takes: [`${t24} from TN-99`] });
    expect(() => activeTicketDesign(root)).toThrow(/TN-99\.md/);
  });

  test("a take cannot cite a draft note", () => {
    const root = project();
    writeNote(root, 24, { contracts: [t24], status: "draft" });
    writeNote(root, 25, { contracts: [t24, t25], takes: [`${t24} from TN-24`] });
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(() => activeTicketDesign(root)).toThrow(/draft/);
  });

  test("a ticket abandoned with --force cannot be taken from", () => {
    const root = taken();
    abandon(root, 24);
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(() => activeTicketDesign(root)).toThrow(/TN-24.*abandoned/);
    expect(ticketWriteScope(root)?.error).toMatch(/abandoned/);
    rmSync(join(root, ".bounded/tickets/24/abandoned"));
    expect(activeTicketDesign(root)?.contracts).toContain(t24);
  });

  test("without a take the overlap still refuses, and says how to transfer", () => {
    const root = project();
    // Ticket #24 was delivered: its frozen design holds the contract.
    mkdirSync(join(root, ".bounded/tickets/24"), { recursive: true });
    writeFileSync(join(root, ".bounded/tickets/24/contract-checksums.json"), JSON.stringify({ files: { [t24]: "0" } }));
    writeNote(root, 25, { contracts: [t24, t25] });
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(() => activeTicketDesign(root)).toThrow(/t24\.contract\.ts belongs to ticket #24/);
    expect(() => activeTicketDesign(root)).toThrow(/takes:/);
  });

  test("two tickets cannot take the same contract from one owner", () => {
    const root = taken();
    writeNote(root, 26, { contracts: [t24], takes: [`${t24} from TN-24`] });
    vi.stubEnv("BOUNDED_TICKET", "26");
    expect(() => activeTicketDesign(root)).toThrow(/TN-25/);
  });

  test("a third ticket takes from the current owner", () => {
    const root = taken();
    writeNote(root, 26, { contracts: [t24], takes: [`${t24} from TN-25`] });
    vi.stubEnv("BOUNDED_TICKET", "26");
    expect(activeTicketDesign(root)?.contracts).toContain(t24);
  });

  test("a contract cannot go back to an earlier owner", () => {
    const root = project();
    writeNote(root, 24, { contracts: [t24], takes: [`${t24} from TN-25`] });
    writeNote(root, 25, { contracts: [t24], takes: [`${t24} from TN-24`] });
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(() => activeTicketDesign(root)).toThrow(
      /no ticket owns contexts\/notes\/src\/t24\.contract\.ts: docs\/tn\/TN-24\.md and docs\/tn\/TN-25\.md take it from each other/);
  });

  test("an abandoned take neither claims nor releases", () => {
    const root = project();
    writeNote(root, 24, { contracts: [t24, t24b] });
    writeNote(root, 25, { contracts: [t24], takes: [`${t24} from TN-24`] });
    abandon(root, 25);
    // The abandoned run's take does not orphan the giver's contract.
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(activeTicketDesign(root)?.contracts).toEqual([t24, t24b]);
    expect(resolveTicketDesign(root, { siblings: "ignore" })).toMatchObject({ kind: "ready", design: { contracts: [t24, t24b] } });
    // Another ticket may still take it from the giver.
    writeNote(root, 26, { contracts: [t24], takes: [`${t24} from TN-24`] });
    vi.stubEnv("BOUNDED_TICKET", "26");
    expect(activeTicketDesign(root)?.contracts).toContain(t24);
    rmSync(join(root, ".bounded/tickets/25/abandoned"));
    expect(() => activeTicketDesign(root)).toThrow(/TN-25/);
  });

  test("a superseded taker's take lapses", () => {
    const root = project();
    writeNote(root, 24, { contracts: [t24] });
    writeNote(root, 26, { contracts: [c("t26")] });
    writeNote(root, 25, {
      contracts: [t24], takes: [`${t24} from TN-24`], status: "superseded", body: "Superseded by [TN-26](TN-26.md).\n",
    });
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(activeTicketDesign(root)?.contracts).toContain(t24);
  });

  test("a sibling's malformed takes: refuses in check mode", () => {
    const root = project();
    writeNote(root, 24, { contracts: [t24] });
    writeNote(root, 25, { contracts: [t24, t25], takes: [`${t24} from 24`] });
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(() => activeTicketDesign(root)).toThrow(
      /^docs\/tn\/TN-25\.md has an unreadable takes: list.*ask the team lead to repair docs\/tn\/TN-25\.md/);
    expect(resolveTicketDesign(root, { siblings: "ignore" }).kind).toBe("ready");
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(() => activeTicketDesign(root)).toThrow(/TN-25\.md has an invalid takes: entry/);
  });
});
