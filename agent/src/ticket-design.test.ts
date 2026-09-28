import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ACTIVE_TICKET_RELATIVE, activeTicketDesign, activeTicketNumber, designNotePath, readActiveTicketFile,
  resolveTicketDesign, ticketWriteScope,
} from "./ticket-design.ts";
import { writeProjectPacks } from "./project-composition.ts";
import { contractFileSuffixes, contractGlobs, hasContractSuffix } from "./pack-contrib.ts";
import { computeManifest, runChecksumGate } from "../packs/ts/scripts/checksum-gate.ts";
import { readReviewed, runRecordDesignReview } from "../packs/ts/scripts/design-review.ts";
import { classifyReviewFreshness } from "../packs/ts/scripts/design-gate.ts";
import { readGuardLog } from "./guard-log.ts";
import { decide } from "./path-policy.ts";
import { evaluatePathGate } from "./path-gate.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-ticket-design-"));
  roots.push(root);
  mkdirSync(join(root, "docs/tn"), { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "docs/tn/README.md"), "# Technical Notes\n");
  writeProjectPacks(root, ["ts"]);
  for (const n of [24, 25]) {
    writeFileSync(join(root, `docs/tn/TN-${n}.md`),
      `---\nissue: ${n}\nstatus: active\ncontracts:\n  - src/t${n}.contract.ts\n---\n\n# Ticket ${n}\n`);
    writeFileSync(join(root, `src/t${n}.contract.ts`), `export interface T${n} {}\n`);
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
      "---\r\nissue: 25\r\nstatus: active\r\ncontracts:\r\n  - src/t24.contract.ts\r\n---\r\n");
    expect(() => activeTicketDesign(root)).toThrow(/both own src\/t24.contract.ts/);
    writeFileSync(join(root, "docs/tn/TN-25.md"),
      "---\nissue: 25\nstatus: superseded\ncontracts:\n  - src/t24.contract.ts\n---\n\nSuperseded by [TN-24](TN-24.md).\n");
    expect(activeTicketDesign(root)?.ticket).toBe("24");
  });

  test("architect writes only its declared contracts, including before creation", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    const scope = ticketWriteScope(root)!;
    expect(scope.contractSuffixes).toEqual([".contract.ts"]);
    const ctx = { cwd: root, ticketScope: scope, contractGlobs: contractGlobs(root) };
    expect(decide("architect", "write", { path: "src/t24.contract.ts" }, ctx).allow).toBe(true);
    expect(decide("architect", "write", { path: "src/t25.contract.ts" }, ctx).allow).toBe(false);
    expect(decide("architect", "write", { path: "src/T24.contract.ts" }, ctx).allow).toBe(false);
    expect(evaluatePathGate({ role: "architect", toolName: "write", input: { path: "src/t25.contract.ts" }, cwd: root })?.reason)
      .toContain("not owned by ticket #24");
    expect(decide("architect", "write", { path: "docs/tn/TN-25.md" }, ctx).allow).toBe(false);
    expect(decide("architect", "write", { path: "spec.md" }, ctx).allow).toBe(false);
    writeFileSync(join(root, "docs/tn/TN-24.md"),
      "---\nissue: 24\nstatus: draft\ncontracts:\n  - src/t24.contract.ts\n  - src/new.contract.ts\n---\n");
    expect(decide("architect", "write", { path: "src/new.contract.ts" },
      { cwd: root, ticketScope: ticketWriteScope(root), contractGlobs: contractGlobs(root) }).allow).toBe(true);
  });

  test("two tickets freeze and review only their own note and contracts", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(Object.keys(computeManifest(root).files)).toEqual(["src/t24.contract.ts"]);
    expect(runRecordDesignReview(root, []).code).toBe(0);
    expect(runChecksumGate(root, true).code).toBe(0);
    const first = readReviewed(root);
    if (!first.ok) throw new Error(first.error);
    expect(Object.keys(first.reviewed)).toEqual(["docs/tn/TN-24.md", "src/t24.contract.ts", "composition:ts"]);
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(runRecordDesignReview(root, []).code).toBe(0);
    expect(runChecksumGate(root, true).code).toBe(0);
    expect(runChecksumGate(root, false).code).toBe(0);
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "src/t25.contract.ts"), "export interface T25 { changed: true }\n");
    expect(runChecksumGate(root, false).code).toBe(0);
    expect(classifyReviewFreshness(readGuardLog(root), first.reviewed, "24").state).toBe("fresh");
    writeFileSync(join(root, "docs/tn/TN-24.md"),
      "---\nissue: 24\nstatus: active\ncontracts:\n  - src/t24.contract.ts\n---\n\n# Revised ticket\n");
    expect(runChecksumGate(root, false).code).toBe(1);
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
    expect(ticketWriteScope(root)).toEqual({ ticket: "26", contracts: [], contractSuffixes: [".contract.ts"] });
    expect(() => activeTicketDesign(root)).toThrow("ticket #26 needs docs/tn/TN-26.md before design review or freeze");
    // A scout may help before the note exists; a worker may not.
    expect(evaluatePathGate({ role: "architect", toolName: "subagent", input: { agent: "scout", task: "look" }, cwd: root }))
      .toBeUndefined();
    expect(evaluatePathGate({ role: "architect", toolName: "subagent", input: { agent: "builder", task: "go" }, cwd: root })
      ?.reason).toMatch(/^phase-gate: cannot commission the builder/);
  });

  test("another ticket's own hygiene never blocks this ticket", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "docs/tn/TN-25.md"), "---\nissue: 99\nstatus: superseded\n---\n\nNo successor link.\n");
    writeFileSync(join(root, "docs/tn/TN-27.md"), "---\nissue: 27\nstatus: bogus\ncontracts:\n  - src/t27.contract.ts\n---\n");
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
    expect(decide("architect", "write", { path: "src/t24.contract.ts" }, { cwd: root, ticketScope: ticketWriteScope(root) }))
      .toEqual({ allow: false, reason: `path-gate: ${reason}` });
    expect(decide("architect", "write", { path: "docs/tn/TN-24.md" }, { cwd: root, ticketScope: ticketWriteScope(root) }).allow)
      .toBe(true);
    expect(resolveTicketDesign(root, { siblings: "ignore" }).kind).toBe("ready");
    writeFileSync(join(root, "docs/tn/TN-25.md"), "---\nissue: 25\nstatus: active\ncontracts:\n  src/t25.contract.ts\n---\n");
    expect(() => activeTicketDesign(root)).toThrow(/^docs\/tn\/TN-25.md has an unreadable contracts: list/);
  });

  test("a design problem becomes the refusal a gated spawn reads, not a hook error", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "docs/tn/TN-24.md"), "---\nissue: 24\nstatus: active\ncontracts:\n  - src/gone.contract.ts\n---\n");
    expect(evaluatePathGate({ role: "architect", toolName: "subagent", input: { agent: "builder", task: "go" }, cwd: root })
      ?.reason).toBe("phase-gate: cannot commission the builder — docs/tn/TN-24.md names missing contract 'src/gone.contract.ts'");
    expect(evaluatePathGate({ role: "architect", toolName: "subagent", input: { agent: "scout", task: "look" }, cwd: root }))
      .toBeUndefined();
  });

  test("a gate that cannot evaluate refuses with a reason instead of throwing", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    rmSync(join(root, ".bounded/composed-packs.json"));
    const result = evaluatePathGate({ role: "architect", toolName: "subagent", input: { agent: "builder", task: "go" }, cwd: root });
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
    expect(hasContractSuffix("src/t24.contract.ts", contractFileSuffixes(root, dir))).toBe(false);
    writeProjectPacks(root, ["plain", "typed"]);
    expect(hasContractSuffix("src/t24.contract.ts", contractFileSuffixes(root, dir))).toBe(true);
    expect(() => contractFileSuffixes(root, packs({ bad: '{"contractFileSuffixes":["contract"]}' })))
      .toThrow(/Selected pack|dotted filename suffix/);
  });

  test("the architect's ownership check follows the scope's suffixes, not a core literal", () => {
    const root = project();
    const scope = { ticket: "24", contracts: [], contractSuffixes: [".design.x"] };
    expect(decide("architect", "write", { path: "src/a.design.x" }, { cwd: root, ticketScope: scope }).allow).toBe(false);
    const unknown = { ticket: "24", contracts: [], contractSuffixes: [], error: "cannot tell which files are contracts" };
    expect(decide("architect", "write", { path: "src/t24.contract.ts" }, { cwd: root, ticketScope: unknown }))
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
