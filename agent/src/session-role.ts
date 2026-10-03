// Which seat a hosted session holds (ADR 2026-048). Each host adapter gathers
// the facts it can prove — a role bound from outside the session, whether the
// adapter is a project's own copy, whether the host marks this as a child,
// whether another bound hook already judges its calls — and this one pure
// function turns them into a seat, so the two hosts cannot disagree.

import { asRole } from "./path-gate.ts";
import { SCOUT_SEAT } from "./lead-state.ts";
import type { Role } from "./path-policy.ts";

export type SessionSeat =
  /** A pipeline role, bound by the host or read from the legacy ambient source. */
  | { readonly kind: "role"; readonly role: Role; readonly bound: boolean }
  /** The project-local user-facing session: read-only coordination. */
  | { readonly kind: "lead" }
  /** Read-only investigation. Also the fail-closed seat for an unbound child. */
  | { readonly kind: "scout"; readonly bound: boolean }
  /** This adapter does not judge the session. */
  | { readonly kind: "none"; readonly note?: string };

export interface SessionFacts {
  /** The seat bound from outside the session (a per-role loader or hook flag). */
  readonly boundSeat?: string;
  /** This adapter is a project-local installation's own copy, in that project. */
  readonly projectLocal: boolean;
  /** The host marks the session as one commissioned by another. */
  readonly child: boolean;
  /** The session runs in a ticket's own worktree (ADR 2026-066), where the
   *  only seat with work to do is that ticket's launched architect. */
  readonly ticketWorktree?: boolean;
  /** Another hook, bound to a known seat, is proven to judge these calls. */
  readonly judgedElsewhere: boolean;
  /** The legacy ambient role, read only when nothing above decides. */
  readonly ambientRole: () => Role | undefined;
}

export function resolveSessionRole(facts: SessionFacts): SessionSeat {
  if (facts.boundSeat !== undefined) {
    if (facts.boundSeat === SCOUT_SEAT) return { kind: "scout", bound: true };
    const role = asRole(facts.boundSeat);
    if (role !== undefined) return { kind: "role", role, bound: true };
    // A binding that names no seat is a configuration error. In a project
    // installation it fails closed to read-only; elsewhere it is said out loud.
    return facts.projectLocal
      ? { kind: "scout", bound: false }
      : { kind: "none", note: `'${facts.boundSeat}' is not a pipeline role or the scout; gate inactive` };
  }
  if (facts.judgedElsewhere) return { kind: "none" };
  // The lead belongs in the main worktree. In a ticket worktree, a session
  // the start command did not launch as the architect is only read-only.
  if (facts.projectLocal) return facts.child || facts.ticketWorktree === true ? { kind: "scout", bound: false } : { kind: "lead" };
  const role = facts.ambientRole();
  return role === undefined ? { kind: "none" } : { kind: "role", role, bound: false };
}
