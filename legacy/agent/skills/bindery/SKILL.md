---
name: bindery
description: Write the definitive short book of the current repository — a layered, present-tense explanation of what the system is and how it works, bound as an EPUB for offline reading (e.g. on a Kindle). Use when the user wants to catch up on a codebase by reading prose away from the screen, or asks for a book, ebook, or long-form guide to a repo.
---

# Bindery

Read this repository deeply and write the definitive short book about it —
the book a thoughtful maintainer would hand a successor before leaving.
Then bind it as an EPUB.

Output goes to `.agent-state/bindery/` in the target repo. The run ends
at the bound file: **never attempt delivery** — no email, no uploads.
Tell the user where the EPUB is; sending it to a device is theirs to do
(Send to Kindle's web uploader takes EPUB; MOBI is dead).

**Name every edition distinctly — the file AND the `dc:title`.** Put the
edition in both (`harness-book-ed1.2.epub`, "The Book (Edition 1.2)").
Not because a collision is known to break anything, but because a reader
whose library already holds earlier editions under one identical title
cannot tell a silent dedupe from an upload that failed: both look like
nothing happening. Distinct names make "it didn't arrive" mean one thing.

## Preflight

Check that `pandoc` is on PATH. If it is not, stop and ask the user
whether to install it (`brew install pandoc`) or to emit markdown only —
do not hand-roll a converter silently. A PDF is optional and only on
request; it needs a pandoc PDF engine (`typst` is the lightweight
choice) — if absent, skip the PDF rather than blocking the EPUB.

## The genre

- **Explanation, not reference.** This is the pilot's handbook, not the
  maintenance manual: it owes the reader command of the system — what it
  is, how it behaves, why it is shaped this way — not completeness. No
  API tables, no config dumps, no exhaustive file tours; the screen
  already serves reference better.
- **Present tense first.** The book's spine is how the system works
  *today*: a reader picking up the project should come away able to
  navigate and reason about it as it stands. Rationale — decisions,
  trade-offs, dead ends — earns its place where it illuminates the
  current mechanism, as a supporting paragraph rather than the lead;
  extended history belongs in the dedicated history chapter, not the
  openings. Where the repo records its reasoning, use that record rather
  than inventing a why; where it is absent, say so honestly.
- Model chapters on the *Architecture of Open Source Applications*
  series: how it's structured, how the parts interact, why it was built
  that way, what would break without it.
- Written prose, full sentences, a real narrative arc. The reader is
  away from the screen and cannot jump to source.

## Survey before writing

1. Read the curated material first — whatever this repo actually has:
   README, any context/glossary doc, and its design or decision records
   under whatever name and shape they take (ADRs, RFCs, design notes, a
   wiki, long commit messages — or nothing at all). Adapt to what
   exists; expect nothing. Then the code.
2. Fan out **read-only exploration subagents** to survey the code — use
   whichever read-only scout/explore agent type your environment
   provides (in pi, `scout`), several in parallel, one per area. Ask
   them for mechanisms and structure, not file dumps; never paste raw
   survey output into a chapter. Pass any user-stated focus or
   exclusions down to every subagent.
3. Identify the **6–10 load-bearing concepts** of the system. These
   become the chapters. Order them pedagogically: each chapter may
   assume only the chapters before it. Spiral, don't fragment — later
   chapters revisit the same system at higher resolution.

## Structure

1. **Preface** — what this book is, the commit it was written at, what
   it deliberately leaves out, and how it was produced. If a previous
   edition's manifest exists (see Binding), open with a short "Changes
   in this edition" note diffed against it.
2. **Overview** (~1,000 words) — what the system is and does today, the
   central bet or inversion at its heart, and a map of the book.
   Present tense; not the story of how it came to be.
3. **6–10 concept chapters**, 1,500–2,500 words each: what it is, how
   it works (mechanism at paragraph level), what would break without
   it — and, briefly, why it is this way where the record explains it.
4. **How it got here** — if the repo records its history in any form:
   the story of the decisions in order, as narrative. This chapter is
   where the history lives, so the concept chapters don't have to
   carry it.
5. **Glossary** — if the repo defines a vocabulary, an appendix derived
   from it, in the repo's own words.

## Code in the book

- Sparse and representative only. An excerpt earns its place when the
  shape of the code *is* the point; otherwise describe it.
- Excerpts ≤ 20 lines, lines ≤ 60 characters (e-ink wraps long lines
  badly). Trim aggressively; `…` elisions are fine.
- A small real artifact (a whole skill file, a config, a rule) may be
  inlined in full when the artifact itself is what's being taught.
- Prose over diagrams. No mermaid, no ASCII art — e-readers butcher
  both. A real book explains; it doesn't lean on figures.

## Truth discipline

- Every mechanism claim must be traceable to a file you or a subagent
  actually read. Track, per chapter, the source files it draws on.
- After drafting, run a **fact-check pass** — non-negotiable; in trial
  runs it corrected dozens of claims per book, including inverted
  mechanisms and invented quotations. For each chapter, dispatch a
  fresh read-only subagent with the chapter text, asking it to verify
  every factual claim against the repo and report anything wrong or
  unsupported. Fix or cut what it flags. A wrong assertion read
  trustingly on a couch is worse than an omission.

## Binding

- Write chapters as numbered markdown files in the output directory
  (`00-preface.md`, `01-overview.md`, …).
- Write `book-manifest.json`: title, edition, git commit, date, table
  of contents, and per-chapter source-file lists. This is the edition
  mechanism — the next run diffs against it for the "Changes in this
  edition" preface note. Bump the edition when one exists.
- **A previous edition's manifest may not be in this directory.** The
  output dir is named after whatever skill produced it, and skills get
  renamed: edition 1.1 sat in `.agent-state/kindling/` and 1.2 opened
  by diffing against it from `.agent-state/bindery/`. Before deciding
  there is no prior edition, look for a `book-manifest.json` anywhere
  under `.agent-state/`, and diff against the newest one for the same
  repo rather than only your own path.
- Bind with pandoc: `--toc`, metadata (title, author "bindery", date,
  lang, edition), and an embedded CSS file: em-based sizing, monospace
  stack with `white-space: pre-wrap`, grayscale-safe — no reliance on
  syntax color.
- **Validate before you report it**, so a later "it won't open" is
  answerable: `unzip -t`, `mimetype` first in the zip and stored
  uncompressed, every XHTML and the OPF well-formed (`xmllint --noout`),
  no duplicate ids, every spine idref in the manifest. Say in the report
  that you checked, so "the file is sound" is a finding rather than an
  assumption.
- **If a validated EPUB still will not load on a device, you do not know
  why.** One did not, on a Kindle, while the two editions before it did —
  and it validated clean and differed from them only in metadata, two
  chapters and one CSS comment. `--to=epub2` is the cheap retry, but it
  is a retry and not a diagnosis: the edition that loaded was EPUB3 too.
  Say what you established (the file is valid) and what you did not (the
  cause), and ask what the device actually reported — an upload error and
  a silent non-arrival point at different things. Do not write a fix into
  this file until one is confirmed.
- Report back: path to the EPUB, total word count, the chapter list,
  and anything the fact-check pass changed or cut.
