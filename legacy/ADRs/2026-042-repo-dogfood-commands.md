# 2026-042: Keep dogfood commands outside the CLI package

**Status:** accepted

## Decision

Dogfood reset, archive and model-probe scripts belong under this repository's
`scripts/dogfood/`. The `bounded` router does not expose them, and the npm
package's file list includes only runtime CLI scripts.
The npm-installed `bounded` entry point exposes initialization, version and
help; project gates and lifecycle commands run from the project's local
harness. The source checkout retains its development router.

## Why

Dogfood commands operate this repository's experiment arms and archive. They
are maintenance tools, not capabilities needed to initialize or maintain a
consumer project.

## Consequences

Contributors invoke them from the harness checkout. Packaged CLI installs
contain no dogfood entry points. The initialized project continues to carry
only its selected harness commands.
