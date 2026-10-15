# demo-package/demo: a demonstration pack

A pack for the package catalogue build's tests.

## What it is for

Keeping notes a project writes for its agents.

## Rule shape

Projects contribute notes to `notes`: `{ text }`, one line each.

## Workflows it fits

- **Any:** a project that wants to tell its agents something.

## What it observes

Every tool call, before it runs; it allows each one.

## What it cannot see

Anything an agent does.

## Ports

- `noteStore` (`NoteStore`): where notes are kept.

## Examples

- `basic.config.ts`, with `basic.scenarios.ts`: the project keeps one note.

## Records

None are kept.
