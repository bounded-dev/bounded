# Run 31 — Wrthy net-worth tracker, team lead on Claude Code (2026-10-02 to 03)

The user started from an empty directory with a plain-language idea: a
multi-tenant net-worth tracker ("Wrthy") with accounts, a spine of readings,
multi-currency, ownership shares and tagging. They talked it through with an
unguarded pre-init session, then ran `bounded init` (web, API, MCP, Postgres)
and drove the work through the team lead. The run is **in progress**. At this
record's cutoff ticket #2 (accounts) was delivered, the lead was waiting on two
user decisions, and tickets #3 and #4 had not started. The guard log stays live
for the next record.

Harness: initialized at `629da22`; on 2026-10-03 the project's harness copy was
patched by hand with `9c584a0`, the adapter-law `@accepts` candidates and the
Claude Code SendMessage continuation. #43 tracks the missing update path.

## Timeline (UTC)

- **15:09 to 15:32:** spec conversation before init. No harness was installed
  yet, so the session wrote `SPEC.md` with a table-level data model, which the
  user then asked it to remove.
- **15:32:** init refused the non-empty directory (`SPEC.md`). The lead moved
  the spec to its scratchpad, and its restore was refused. The spec never
  re-entered the project, so architects worked from the lead's summaries.
- **15:34 to 15:43:** two scouts read harness internals to learn what the stack
  supports. Both reports were lost: `SubagentHandback` was refused for the
  scout seat.
- **Ticket #1:** design 10 min, then tests and build in parallel 16 min, ending
  blocked. It stalled overnight: OrbStack was down, and the adapter-law
  candidate bug was hit. It was finished 05:09 to 05:20 after the hand patch.
- **Ticket #2:** 05:20 to 06:14. Design 15 min, tests and build 18 min,
  mutation score about 17 min.
- **Tokens:** about 77M input, mostly cache reads. Builders 27M, test-writers
  21M, architects 20M, lead 3.8M, the lost scouts 3.7M, reviewers 1.3M.

## Harness problems found

| Problem | Kind | Tracked |
|---|---|---|
| Pre-init session designed a data model; no product role exists | design gap | #41 |
| Init refuses an existing spec file; restart needed for the new agents | harness bug | #42 |
| Scout reads harness internals to learn what is supported | missing capability | #42 |
| Adapter laws could not find a valid `CurrencyCode` | harness bug | fixed `9c584a0` |
| SendMessage continuation refused over the `content` field | harness bug | fixed `61fd6e0` |
| Scout `SubagentHandback` refused; lead cannot `ToolSearch`; spill files unreadable | harness bug | #47 |
| `mutation-score` killed at the 10-minute limit left a mutant in place | harness bug | #48 |
| Mutation run capped at 10 of 397 sites, so the score was weak | harness gap | #48 |
| Builder runs get no `DATABASE_URL`; app smoke tests always fail | harness bug | #48 |
| Sign-off help gives no finding shape and offers a refused flag | harness bug | #48 |
| A later ticket cannot take over a delivered ticket's contract (E12 unenforced) | harness gap | #49 |
| First design freeze blocked by an earlier ticket's composition roots; architect stripped tags to get past it | harness bug | #44 (generated roots), #49 |

Smaller friction: 17 refusals for contracts written before the TN front
matter, and 28 shell-grammar refusals of multi-path `ls`/`find`/`grep`.

## Gold nuggets: what the guards caught

1. **A cross-workspace delete bug.** The killed mutation run left `!==` in the
   workspace check of `delete-account.store.ts`. `mutation-score` refused to
   run on a red suite (06:07:21), and green caught the flipped check (06:08:07)
   before it could ship.
2. **The domain was not bent to fit a generator bug.** Faced with the
   adapter-law failures, the builder refused to make `CurrencyCode` accept
   "Example" (CONTRACT-DISPUTE), and the resumed architect rejected a
   `generate()` workaround. That surfaced the generator bug instead of
   corrupting the domain.
3. **Design errors found before any code.** The TN-2 reviewer found:
   - the CLOSED pill showed for a future end date;
   - a currency change silently re-denominated an account's history;
   - unnormalized `-0`;
   - tag-format logic leaking into a store.
4. **Gaps turned into product decisions.** The TN-1 reviewer found member names
   weren't unique and rename-workspace was missing; the user accepted both.
5. **No store code without real Postgres.** Green refused without a container
   runtime (16:14:27), so store code was never accepted untested.
6. **A real bug from blind boundary tests.** A name-length test written blind
   caught zod counting code points rather than UTF-16 code units.
7. **Staleness checks.** A stale design review forced a re-review (05:11:02),
   and green caught a stale MCP smoke-test tool list (05:55:12).
