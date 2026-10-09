import type { Composition, EffectGuard, ExecuteEffect, ListEffect, ReadEffect, WriteEffect } from "bounded/domain";

// The protected-paths pack judges calls: reads, listings and writes against its
// protected paths, and shell commands by what their reading (ADR 2026-020)
// says they read, list and write. It needs no port of its own for that: every
// execute effect carries the reading the host adapter built for its command.

// What this feature contributes to the core: a guard per effect kind it judges.
/** Judges a read against the protected paths. */
export type JudgeRead = EffectGuard<ReadEffect, Composition>;
/** Judges a listing against the protected paths. */
export type JudgeList = EffectGuard<ListEffect, Composition>;
/** Judges a write against the protected paths. */
export type JudgeWrite = EffectGuard<WriteEffect, Composition>;
/** Judges a shell command by what its reading says it reads, lists and writes. */
export type JudgeExecute = EffectGuard<ExecuteEffect, Composition>;
