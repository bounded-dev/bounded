# bounded-example

The fixture that keeps [Bounded](https://github.com/bounded-dev/bounded)'s
published-pack slot tested ([ADR 2026-030](https://github.com/bounded-dev/bounded/blob/main/docs/adr/2026-030-published-packs.md)).
A published pack is a pack that is its own npm package, installed beside
`bounded` (its peer dependency), for packs tied to one vendor or one language.

This package is private and is never published: the repository's tests
build it, pack it and install it beside `bounded`, as a project would install
a real published pack.

It holds one pack, `bounded-example/refused-tools`
([its README](./packs/refused-tools/README.md)), which refuses every tool use
of the tool kinds a project lists.
