// How a file another ticket owns is changed: a run on the owning ticket, never
// an edit of its design note, which for a delivered ticket is its frozen
// record. The lead switches tickets only after the active one is delivered,
// so while a ticket is active the route waits for that delivery. One wording,
// shared by the design refusal (ticket-design.ts) and the path gate
// (path-policy.ts). Pure: no fs.

/** Ownership facts about one ticket, as the refusal needs them. */
export interface RouteTarget {
  readonly ticket: string;
  /** It has a frozen design, so the lead will prepare a change run on it. */
  readonly frozen: boolean;
  /** Its last run was abandoned, so no ticket may take a contract from it
   *  (ADR LEG-2026-071). */
  readonly abandoned?: boolean;
}

const NEVER_EDIT = "never edit another ticket's design note";

/** The route to change a file `target` owns, from a session where `active`
 *  (if any) is the selected ticket. */
export function changeRunRoute(target: RouteTarget, active: string | undefined): string {
  const wait = active !== undefined ? "after the active ticket is delivered, " : "";
  const run = target.frozen ? "a change run" : "a run";
  return `${wait}change it in ${run} on ticket #${target.ticket}; ${NEVER_EDIT}`;
}

/** The refusal for a contract another ticket owns. When the owner has a
 *  frozen design, was not abandoned, and a ticket is active, that ticket may
 *  instead take the contract over in its own note (ADR LEG-2026-071). */
export function foreignContractRefusal(path: string, owner: RouteTarget, active: string | undefined): string {
  const route = `contract ${path} belongs to ticket #${owner.ticket}: ${changeRunRoute(owner, active)}`;
  const takeable = owner.frozen && owner.abandoned !== true && active !== undefined;
  return takeable ? `${route}. ${takeAlternative(path, owner.ticket)}` : route;
}

/** How the active ticket takes over a delivered ticket's contract. */
function takeAlternative(path: string, owner: string): string {
  return "If this ticket's design must change it, take it over in this ticket's own note instead: " +
    `list it with its other contracts and add the line \`  - ${path} from TN-${owner}\` under \`takes:\``;
}

/** The refusal for a contract several tickets claim when no single frozen
 *  design settles which owns it. */
export function contestedContractRefusal(path: string, tickets: readonly string[]): string {
  const named = tickets.map((ticket) => `ticket #${ticket}`);
  const list = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named.join("");
  return `contract ${path} is claimed by ${list}, and no single frozen design settles which owns it: ` +
    `return it to the team lead to decide; ${NEVER_EDIT}`;
}
