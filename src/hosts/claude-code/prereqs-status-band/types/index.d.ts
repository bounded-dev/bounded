// The prereqs status band's state contract (ADR 2026-027), named by its
// plugin.json: its one value in $.state, when it last saw a finished tool
// call or agent run, in milliseconds from $.clock.now(); null when reset.
declare module "claude-code" {
  interface PluginState {
    "bounded-prereqs-status-band": { lastFinishSeenAt: number | null };
  }
}
