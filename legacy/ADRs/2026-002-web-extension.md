# 2026-002: Custom web extension

**Status:** accepted

## Decision

Keep the custom `extensions/web.ts` (`web_search` + `web_fetch`) instead of the
off-the-shelf `npm:pi-web-access` package.

## Why

- Zero dependencies, fully auditable, no third-party code running with system
  access (`pi-web-access` is 7 MB with 8 dependencies).
- Covers current needs: search + URL fetch.

## Consequences

- We maintain the Mojeek HTML-scrape fallback ourselves.
- No GitHub cloning, PDF extraction, or video understanding — revisit if those
  become needs.
- Brave key resolution: `BRAVE_API_KEY` env var overrides the gitignored
  `web-search.json` in the harness root. The file is the reliable path — GUI
  launchers don't inherit shell env, so a key that only lives in
  `~/.zshrc` silently goes missing. Any extension needing a key follows the
  same pattern: own gitignored `<name>.json`, env var overrides, never
  committed or logged.
