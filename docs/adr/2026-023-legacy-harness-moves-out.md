# 2026-023: The original harness moves out of `legacy/` to its own repository

**Status:** accepted (the maintainer's decision). Amends
[ADR 2026-014](2026-014-legacy-harness-moves-to-legacy.md): the original
harness is no longer kept in `legacy/`.

## Decision

- **The original harness lives in the private repository
  `bounded-dev/bounded-legacy`.** Its history there is the original
  harness's own, up to the commit before it moved into `legacy/`
  (`7081c6a` here), followed by one commit that brings it to the state
  `legacy/` held when it left (the `LEG-2026-NNN` ADR names and later link
  updates, with the original `LICENSE`), at that repository's root.
- **This repository no longer contains `legacy/`.** The directory is
  deleted in one commit; its files remain in this repository's history.
  The tooling that only existed to keep `legacy/` out of the build (the
  Biome ignore, the `bun test` ignore) is removed with it.
- **It stays reference only.** Contributors check it out beside this
  repository (conventionally as `bounded-legacy`) to read it; nothing here
  imports, builds or copies from it. Its ADRs keep their `LEG-2026-NNN`
  numbers, and a decision here that draws on one still cites it by that
  number.

## Why

The legacy tree is 900 files of a design this code replaced. Keeping it in
the working tree put it in every search, review and agent's view of the
project, and needed tooling to keep it out of the build. Its own repository
keeps it readable, with its history, without making it part of this one.

## Consequences

- Links into `legacy/` written before this decision (in earlier ADRs, for
  example ADR 2026-002's prior-art note) now refer to the same path at the
  root of `bounded-dev/bounded-legacy`. They are left as written, like other
  past ADR text.
- `bounded-dev/bounded-legacy` is private: references to it from this public
  repository name it, but readers outside the organisation cannot open it.
