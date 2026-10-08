// typecheck gate — the worker `typecheck` tool and `bounded gates typecheck` as one
// call (ADR 2026-034).
//
// typecheck.ts runs tsc and redacts machine paths; typecheck-scope.ts narrows
// the diagnostics to what a role may see. Both are pure. What was missing was
// the boundary that joins them and writes the guard event, and it lived only
// in the pi extension — so a second host, or a person at a shell, would have
// had a typecheck that logged nothing and scoped nothing. This is that
// boundary. The role is a parameter: pi resolves it from the session binding,
// the CLI takes `--role`, and an unbound call sees the whole project.

import type { Role } from "../../../src/path-policy.ts";
import { ROLES_UPSTREAM_FIRST } from "../../../src/path-policy.ts";
import { logGuardEvent } from "../../../src/guard-log.ts";
import { pathLayoutOrUnreadable } from "../../../src/pack-contrib.ts";
import type { GateResult } from "../../../src/gate-result.ts";
import { typecheck, type TypecheckOptions } from "./typecheck.ts";
import { configDriftBlock } from "./project-config.ts";
import { formatScopedTypecheck, scopeGuardDetail, scopeTypecheck } from "./typecheck-scope.ts";

const GUARD = "typecheck";

/** Narrow a caller-supplied role name (`--role`); undefined when it is not one. */
export function parseRole(raw: string | undefined): Role | undefined {
  return ROLES_UPSTREAM_FIRST.find((r) => r === raw);
}

/**
 * Type-check `cwd` (`bunx tsc -p tsconfig.json`), scope the diagnostics to `role` (none: the
 * whole project), and log one guard event. The event's summary is always the
 * WHOLE project's verdict — the guard log is the orchestrator's evidence, and
 * it is never scoped — while the lines are what the caller may see.
 */
export async function typecheckGate(
  cwd: string,
  role?: Role,
  options: TypecheckOptions = {},
): Promise<GateResult> {
  const configBlock = configDriftBlock(GUARD, cwd);
  if (configBlock !== undefined) return configBlock;
  const result = await typecheck(cwd, options);
  // Raw tsc output is project-wide, so this tool was a hole in the same wall
  // run_tests and the path gate build (dogfood Run 15): a builder read a test
  // file's diagnostic — file, line, and the symbol name — out of its own
  // typecheck and reshaped the implementation around test source it may
  // never read.
  const scoped = scopeTypecheck(result, role, pathLayoutOrUnreadable(cwd));
  const summary = result.ok
    ? "no type errors"
    : `${result.errorCount} error${result.errorCount === 1 ? "" : "s"}`;
  logGuardEvent(cwd, {
    guard: GUARD,
    verdict: result.ok ? "pass" : "block",
    summary,
    detail: scopeGuardDetail(scoped),
  });
  return {
    code: result.ok ? 0 : 1,
    verdict: result.ok ? "pass" : "block",
    summary,
    lines: formatScopedTypecheck(scoped).split("\n"),
    detail: {
      ok: result.ok,
      errorCount: scoped.scoped ? scoped.shown : result.errorCount,
      ...(scoped.scoped ? { scoped: true, hidden: scoped.hidden } : {}),
    },
  };
}
