// How a file another ticket owns is changed: a change run on the owning
// ticket, never an edit of its design note, which for a delivered ticket is
// its frozen record. One wording, shared by the design refusal
// (ticket-design.ts) and the path gate (path-policy.ts). Pure: no fs.

/** The route to change a file that ticket `owner` owns. */
export function changeRunRoute(owner: string): string {
  return `change it in a change run on ticket #${owner}; never edit another ticket's design note`;
}

/** The refusal for a contract another ticket owns. */
export function foreignContractRefusal(path: string, owner: string): string {
  return `contract ${path} belongs to ticket #${owner}: ${changeRunRoute(owner)}`;
}
