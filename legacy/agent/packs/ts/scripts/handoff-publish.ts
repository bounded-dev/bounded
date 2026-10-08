// Publish a portable ticket handoff from this pack's existing design freeze.
// The team lead receives hashes and a Git revision, not stack-specific knowledge.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logGuardEvent, readGuardLog } from "../../../src/guard-log.ts";
import type { GateResult } from "../../../src/gate-result.ts";
import { makeReceipt, repoPrefix } from "../../../src/handoff.ts";
import { computeManifest, diffManifests, hasDrift, manifestRelative, type Manifest } from "./checksum-gate.ts";
import { readReviewed } from "./design-review.ts";
import { activeTicketDesign, designNotePath } from "../../../src/ticket-design.ts";

const NAME = "handoff-publish";

function result(cwd: string, code: 0 | 1 | 2, summary: string, detail: Readonly<Record<string, unknown>> = {}): GateResult {
  const verdict = code === 0 ? "pass" : code === 1 ? "block" : "error";
  const out = { code, verdict, summary, lines: [`${NAME}: ${summary}`], detail } as const;
  logGuardEvent(cwd, { guard: NAME, verdict, summary, detail });
  return out;
}

/** The latest design-gate verdict is authoritative; a later failed re-freeze blocks publication. */
export function runHandoffPublish(cwd: string, producer: string): GateResult {
  if (!producer.trim()) return result(cwd, 2, "producer ticket is required");
  const ticket = activeTicketDesign(cwd);
  if (ticket && producer !== ticket.ticket) return result(cwd, 2, `producer must match active ticket #${ticket.ticket}`);
  const latest = readGuardLog(cwd).filter((e) => e.guard === "design-gate" &&
    (e.detail as { ticket?: unknown } | undefined)?.ticket === ticket?.ticket).at(-1);
  if (latest?.verdict !== "pass") return result(cwd, 1, "no standing design-gate freeze");
  const frozen = (latest.detail as { frozenDesign?: unknown } | undefined)?.frozenDesign;
  if (typeof frozen !== "object" || frozen === null || Array.isArray(frozen)) {
    return result(cwd, 1, "freeze has no portable design fingerprint; re-run design-gate");
  }

  let stored: Manifest;
  try {
    stored = JSON.parse(readFileSync(join(cwd, manifestRelative(cwd)), "utf8")) as Manifest;
    if (typeof stored.files !== "object" || stored.files === null) throw new Error("invalid manifest");
  } catch {
    return result(cwd, 1, "freeze manifest is missing or malformed");
  }
  const current = computeManifest(cwd);
  if (hasDrift(diffManifests(stored, current))) return result(cwd, 1, "contracts changed since freeze");

  const reviewed = readReviewed(cwd);
  if (!reviewed.ok) return result(cwd, 1, reviewed.error);
  const atFreeze = frozen as Record<string, unknown>;
  const note = designNotePath(cwd);
  for (const path of [note, ...Object.keys(current.files)]) {
    if (atFreeze[path] !== reviewed.reviewed[path]) {
      return result(cwd, 1, `${path} changed since freeze`);
    }
  }

  try {
    const prefix = repoPrefix(cwd);
    const selectors = [note, ...Object.keys(current.files)].map((path) => `${prefix}${path}`);
    const receipt = makeReceipt(cwd, producer, "design-gate", selectors);
    const expected = selectors.sort();
    const found = Object.keys(receipt.files).sort();
    if (JSON.stringify(found) !== JSON.stringify(expected)) {
      return result(cwd, 1, "committed design file set differs from frozen design");
    }
    for (const repoPath of expected) {
      const local = repoPath.slice(prefix.length);
      const digest = createHash("sha256").update(readFileSync(join(cwd, local))).digest("hex");
      if (receipt.files[repoPath] !== digest) {
        return result(cwd, 1, `${local} differs from the committed revision`);
      }
    }
    return result(cwd, 0, `published frozen design for ${producer} at ${receipt.revision}`, { receipt });
  } catch (error) {
    return result(cwd, 2, error instanceof Error ? error.message : String(error));
  }
}
