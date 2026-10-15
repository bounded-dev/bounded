// Never run: tsc reads it under bun run check:prereqs-status-band, against the
// declarations Claude Code lays beside the band (ADR 2026-027), and proves
// hooks/engine-subset.ts is the engine's own: each hook and .catch handler
// type the band's `on` takes (hooks/register.ts is typed by it) is one the
// engine's `on` takes for that event.
//
// Each event is checked on its own because assigning the band's register to
// the engine's Register cannot check this: `on` is overloaded on both sides,
// and tsc relates two overloaded function types with their generics erased to
// any, so each hook is compared with any and each .catch handler with
// ($: unknown, e: unknown, next: Caught), which no handler that calls next
// satisfies: the assignment fails whatever the subset says.
import type { CatchHandler, Hook, MatchedHook } from "claude-code";
import type { PassingCatch, PassingHook, RenderCatch, RenderHook, SubagentStopFields } from "../hooks/engine-subset";

type AbovePromptHook = MatchedHook<"ui.render", { readonly component: "AbovePrompt" }>;

declare const passing: PassingHook<object>;
declare const passingCatch: PassingCatch<object>;
declare const subagentStop: PassingHook<SubagentStopFields>;
declare const subagentStopCatch: PassingCatch<SubagentStopFields>;
declare const render: RenderHook;
declare const renderCatch: RenderCatch;

export const sessionStart = { hook: passing satisfies Hook<"session.start">, catch: passingCatch satisfies CatchHandler<Hook<"session.start">> };
export const postToolUse = { hook: passing satisfies Hook<"classic.PostToolUse">, catch: passingCatch satisfies CatchHandler<Hook<"classic.PostToolUse">> };
export const postToolUseFailure = { hook: passing satisfies Hook<"classic.PostToolUseFailure">, catch: passingCatch satisfies CatchHandler<Hook<"classic.PostToolUseFailure">> };
export const subagentStopChecks = { hook: subagentStop satisfies Hook<"classic.SubagentStop">, catch: subagentStopCatch satisfies CatchHandler<Hook<"classic.SubagentStop">> };
export const abovePrompt = { hook: render satisfies AbovePromptHook, catch: renderCatch satisfies CatchHandler<AbovePromptHook> };

