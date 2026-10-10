// The part of Claude Code's plugin API the band uses, typed by hand (ADR
// 2026-027), so the workspace's own tsc checks the band without the engine's
// declarations, which Claude Code lays only beside a plugin it loads.
// tests/register.typecheck.ts assigns the band's register to the engine's
// Register, so tsc against those declarations proves this subset is the
// engine's (bun run check:prereqs-status-band). Every member is a
// function-typed property, so it is checked strictly. Hooks are generic in
// the event, the chain's answer and the element type, so each takes the
// engine's own types when the engine calls it. Types only.

/** The surfaces that draw a component. */
export type Surface = "terminal" | "desktop" | "mobile" | "vscode";

/** The band's one value in $.state: when it last saw a finished tool call or agent run (ADR 2026-027). */
export type LastFinishSeenAtRef = { readonly plugin: "bounded-prereqs-status-band"; readonly key: "lastFinishSeenAt" };

/** The two elements the band draws with, from a surface's table. */
export interface BandElements<Element> {
  readonly Box: (props: { flexDirection: "column"; children: Element[] }) => Element;
  readonly Text: (props: { wrap: "truncate-end"; children: string }) => Element;
}

/** The calls on $ the band makes. */
export interface BandEngine<Element> {
  readonly session: {
    /** The session's project root, absolute. */
    readonly root: () => Promise<string>;
  };
  readonly fs: {
    readonly exists: (path: string) => Promise<boolean>;
    /** Rejects when the file is missing or cannot be read. */
    readonly read: (path: string) => Promise<string>;
    /** With `resolve`, `realPath` too: where the path lands. Rejects when missing. */
    readonly stat: (path: string, options: { resolve: boolean }) => Promise<{ readonly realPath?: string | undefined }>;
  };
  readonly state: {
    readonly get: (ref: LastFinishSeenAtRef) => Promise<{ readonly value: number | null | undefined; readonly version: number }>;
    readonly set: (ref: LastFinishSeenAtRef, value: number | null, options: { ifVersion: number }) => Promise<{ readonly isSet: boolean; readonly version: number }>;
  };
  readonly clock: {
    /** Milliseconds since the epoch. */
    readonly now: () => Promise<number>;
    /** Calls `fn` once after `ms` milliseconds, unless the module reloads first. */
    readonly after: (ms: number, fn: () => void) => unknown;
    /** Calls `fn` every `ms` milliseconds until the module reloads. */
    readonly every: (ms: number, fn: () => void) => unknown;
  };
  readonly ui: {
    readonly invalidate: (event: "ui.render") => void;
    readonly resolve: (e: { readonly surface: Surface; readonly component: "AbovePrompt" }) => BandElements<Element>;
  };
}

/** `next` in a hook: the rest of the chain, resolving to its answer. */
export type Next<E, Answer> = (e: E) => Promise<Answer>;

/** A hook on a classic hook event or session.start, which passes the chain's answer through. */
export type PassingHook<Fields> = <E extends Fields, Answer, Element>($: BandEngine<Element>, e: E, next: Next<E, Answer>) => Promise<Answer>;

/** What `next` carries into a `.catch` handler: why the hook failed. */
export interface Caught {
  readonly error: { readonly kind: string; readonly message?: string | undefined };
}

/** The handler a registration's `.catch` sets: here, the chain's answer, run once. */
export type PassingCatch<Fields> = <E extends Fields, Answer, Element>($: BandEngine<Element>, e: E, next: Next<E, Answer> & Caught) => Promise<Answer>;

/** The band above the prompt, as its ui.render hook receives it. */
export interface AbovePromptFields {
  readonly surface: Surface;
  readonly component: "AbovePrompt";
  readonly props: { readonly hasSurvey: boolean };
}

/** The ui.render hook on AbovePrompt: a tree, or the engine's own (`next`). */
export type RenderHook = <E extends AbovePromptFields, Answer, Element>($: BandEngine<Element>, e: E, next: Next<E, Answer>) => Promise<Element | Answer>;

/** The ui.render hook's `.catch`: a tree saying the band could not draw, or undefined for the engine's own. */
export type RenderCatch = <E extends AbovePromptFields, Answer, Element>($: BandEngine<Element>, e: E, next: Next<E, Answer> & Caught) => Element | undefined;

/** What `on` answers: the registration, whose `.catch` sets the handler run when the hook throws. */
export interface Registration<Handler> {
  readonly catch: (handler: Handler) => void;
}

/** A SubagentStop: the agent type it carries may be empty. */
export interface SubagentStopFields {
  readonly agent_type: string;
}

/** `on`, for the events the band hooks. */
export interface On {
  (event: "session.start", hook: PassingHook<object>): Registration<PassingCatch<object>>;
  (event: "classic.PostToolUse", hook: PassingHook<object>): Registration<PassingCatch<object>>;
  (event: "classic.PostToolUseFailure", hook: PassingHook<object>): Registration<PassingCatch<object>>;
  (event: "classic.SubagentStop", hook: PassingHook<SubagentStopFields>): Registration<PassingCatch<SubagentStopFields>>;
  (event: "ui.render", matcher: { readonly component: "AbovePrompt" }, hook: RenderHook): Registration<RenderCatch>;
}
