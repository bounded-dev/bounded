# Tool-managed drop zone

External tools that want into the pi session install their own extension
files here at runtime — untracked, never hand-edited (ADR 2026-006). The
harness's own pi adapter lives in `hosts/pi/extensions/`.
