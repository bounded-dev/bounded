// Bash's brace expansion of literal text, done statically: comma lists
// ({a,b}) and ranges ({1..3}, {a..e}, {01..10}, {1..9..2}), nested, left to
// right. Where the shells read a group differently (bash 3.2, bash 5 and zsh
// were recorded; ADR 2026-020), every word any of them gives is given, with
// the reading before this one's, and where that reading could not spell a
// word out, the word as written is also left to the shell (alsoUnresolved).
// Text keeps its backslash escapes, which make a character literal (quoted
// text arrives escaped, so it never expands). More than MAX_WORDS words is
// more than this will spell out. Each pass over a text is linear in its
// length, and every pass is charged to `charge`: when it refuses, the
// expansion stops, too costly to finish.

const MAX_WORDS = 256;
/** The longest group sliced as a candidate range whatever it holds ({-2147483648..2147483647..1} is 27 characters); a longer one only when it holds nothing a numeric range could not. */
const MAX_RANGE_LENGTH = 48;
/** A numeric range's whole text, with its optional step, each number optionally signed: anchored, no nested quantifiers, so it backtracks at most linearly. */
const NUMERIC_RANGE = /^([-+]?\d+)\.\.([-+]?\d+)(?:\.\.([-+]?\d+))?$/;
/** A letter range's whole text, with its optional step. */
const LETTER_RANGE = /^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.([-+]?\d+))?$/;
/** How many characters a pass goes between two charges of nothing, which look at the time. */
export const CHARGE_EVERY = 4096;

/** What brace expansion gives when it costs more than it was allowed. */
export const TOO_COSTLY = "too-costly" as const;

/**
 * A text brace-expanded: every word a recorded shell could give (escaped),
 * and whether the text, as written, is also one only the shell can make
 * sense of: where the reading before this one left it unresolved, or where
 * no word can be given (a step of zero, past the integers held exactly, or
 * more than MAX_WORDS words).
 */
export interface BraceExpansion {
  readonly words: readonly string[];
  readonly alsoUnresolved: boolean;
}

/**
 * No word can be spelt out: the text (escaped, a group in it kept as
 * written) is still a word, as a shell that leaves the group alone gives it,
 * and only the shell can make sense of it too. Never a bare unresolved
 * report: the literal word stays judged.
 */
const asWritten = (text: string): BraceExpansion => ({ words: [text], alsoUnresolved: true });

/** What rangeWords gives for a group that is no range. */
const NOT_A_RANGE = "not-a-range" as const;

/** A brace group in a text: where it closes, where its top-level commas are, and whether it holds a group of its own and a `..` at its own level, as a range would. */
interface Group {
  readonly end: number;
  readonly commas: readonly number[];
  readonly holdsGroup: boolean;
  readonly rangeDots: boolean;
}

/** Every brace group in `text` that closes, by where it opens: one pass with a stack, escapes skipped. */
function groupsOf(text: string): Map<number, Group> {
  const groups = new Map<number, Group>();
  const open: { readonly start: number; readonly commas: number[]; holdsGroup: boolean; rangeDots: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "{") open.push({ start: index, commas: [], holdsGroup: false, rangeDots: false });
    else if (char === "," && open.length > 0) open.at(-1)?.commas.push(index);
    else if (char === "." && text[index + 1] === "." && open.length > 0) {
      const around = open.at(-1);
      if (around !== undefined) around.rangeDots = true;
    } else if (char === "}") {
      const closed = open.pop();
      if (closed === undefined) continue;
      groups.set(closed.start, { end: index, commas: closed.commas, holdsGroup: closed.holdsGroup, rangeDots: closed.rangeDots });
      const around = open.at(-1);
      if (around !== undefined) around.holdsGroup = true;
    }
  }
  return groups;
}

/** `text` with every character that could expand escaped, so a range's word, or a group kept as written, stays literal. */
const escaped = (text: string): string => text.replace(/[\\{},.]/g, "\\$&");

/** Whether a range's end is written zero-padded (01, 007, -05, +01): bash 5 and zsh then pad every word to the wider end's written width. */
const zeroPaddedEnd = (end: string): boolean => /^[-+]?0\d/.test(end);

/** The numbers from `from` to `to`, `size` apart, in order. */
function sequence(from: number, to: number, size: number): number[] {
  const direction = from <= to ? 1 : -1;
  const values: number[] = [];
  for (let at = from; direction > 0 ? at <= to : at >= to; at += direction * size) values.push(at);
  return values;
}

/**
 * The words of a range group, given its inside, every way a recorded shell
 * expands it (/bin/bash 3.2.57, zsh 5.9 and bash 5.3.20; ADR 2026-020),
 * escaped, with the reading before this one's; NOT_A_RANGE when it is no
 * range.
 * - Bash 3.2 neither pads nor steps: {01..03} gives 1 2 3, and a stepped
 *   group stays as written.
 * - Bash 5 and zsh pad a zero-padded range to the wider end's written width,
 *   the sign included, zeros after a minus ({-01..2}: -01 000 001 002), and
 *   step ({1..5..2}: 1 3 5).
 * - A plus sign: bash reads the number (bash 5 padding and stepping as
 *   above: {+01..03} gives 001 002 003); zsh keeps the group as written.
 * - A negative step: bash 3.2 keeps the group as written, bash 5 steps by
 *   its size, zsh reverses: the words of its size, and the group as
 *   written.
 * - Letter steps: bash 5 steps; bash 3.2 and zsh keep the group as written.
 * Where the reading before this one left the group unresolved (a negative
 * step, a zero-padded range with a negative end), it still does
 * (alsoUnresolved). A step of zero (not recorded), an end or step past the
 * integers held exactly, or more than MAX_WORDS words gives the group as
 * written, and leaves it to the shell too.
 */
function rangeWords(inside: string): BraceExpansion | typeof NOT_A_RANGE {
  const numbers = NUMERIC_RANGE.exec(inside);
  const letters = numbers === null ? LETTER_RANGE.exec(inside) : null;
  const parts = numbers ?? letters;
  if (parts === null) return NOT_A_RANGE;
  const written = escaped(`{${inside}}`);
  const [, fromText = "", toText = "", stepText] = parts;
  const [from, to] = numbers !== null ? [Number(fromText), Number(toText)] : [fromText.charCodeAt(0), toText.charCodeAt(0)];
  const step = stepText === undefined ? 1 : Number(stepText);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isSafeInteger(step) || step === 0) return asWritten(written);
  const size = Math.abs(step);
  if (Math.floor(Math.abs(to - from) / size) >= MAX_WORDS) return asWritten(written);
  const words = new Set<string>();
  if (numbers === null) {
    // A negative letter step is not recorded: unresolved, as before, and the group as written.
    if (step < 0) return asWritten(written);
    for (const value of sequence(from, to, size)) words.add(escaped(String.fromCharCode(value)));
    if (stepText !== undefined) words.add(written);
    return { words: [...words], alsoUnresolved: false };
  }
  const zeroPadded = zeroPaddedEnd(fromText) || zeroPaddedEnd(toText);
  const width = Math.max(fromText.length, toText.length);
  const padded = (value: number): string => (value < 0 ? `-${String(-value).padStart(width - 1, "0")}` : String(value).padStart(width, "0"));
  const values = sequence(from, to, size);
  if (inside.includes("+")) {
    // Bash 3.2: the numbers, neither padded nor stepped (a stepped group stays as written, below).
    if (stepText === undefined) for (const value of values) words.add(escaped(String(value)));
    // Bash 5: stepped, and padded to the written width, the sign included.
    for (const value of values) words.add(zeroPadded ? padded(value) : escaped(String(value)));
    // Zsh, and the reading before this one's: the word as written.
    words.add(written);
    return { words: [...words], alsoUnresolved: false };
  }
  for (const value of values) {
    words.add(escaped(String(value)));
    if (zeroPadded) words.add(padded(value));
  }
  // Bash 3.2 has no step: there the group stays as written.
  if (stepText !== undefined) words.add(written);
  return { words: [...words], alsoUnresolved: step < 0 || (zeroPadded && (from < 0 || to < 0)) };
}

/**
 * Whether `text` from `from` to `to` holds only digits, dots and signs with
 * a `..` among them: it could be a numeric range. It stops at the first
 * other character, so nested groups (which start with one) cost constant
 * time each; a group it passes whole holds no other group, so the groups it
 * lets be sliced never overlap, and a pass stays linear.
 */
function numericOnly(text: string, from: number, to: number): boolean {
  let dots = false;
  for (let index = from; index < to; index++) {
    const char = text.charCodeAt(index);
    if (char === 46) dots ||= text.charCodeAt(index + 1) === 46;
    else if (char !== 45 && char !== 43 && (char < 48 || char > 57)) return false;
  }
  return dots;
}

/**
 * The union of `readings`, each made in turn, repeats dropped. The first is
 * the reading before this one's: past MAX_WORDS words, it alone is kept,
 * and the text is left to the shell too, so the added readings never cost
 * it its words.
 */
function union(readings: readonly (() => BraceExpansion | typeof TOO_COSTLY)[]): BraceExpansion | typeof TOO_COSTLY {
  const words: string[] = [];
  const seen = new Set<string>();
  let alsoUnresolved = false;
  let first: BraceExpansion | undefined;
  for (const reading of readings) {
    const expanded = reading();
    if (expanded === TOO_COSTLY) return expanded;
    first ??= expanded;
    alsoUnresolved ||= expanded.alsoUnresolved;
    for (const word of expanded.words) {
      if (seen.has(word)) continue;
      seen.add(word);
      words.push(word);
    }
    if (words.length > MAX_WORDS) return { words: first.words, alsoUnresolved: true };
  }
  return { words, alsoUnresolved };
}

/** `text` brace-expanded, every way a recorded shell does; TOO_COSTLY when `charge`, given each pass's length and nothing every CHARGE_EVERY characters within one, refuses. */
export function expandBraces(text: string, charge: (steps: number) => boolean): BraceExpansion | typeof TOO_COSTLY {
  // Text with no brace has nothing to expand: one scan, and nothing charged.
  if (!text.includes("{")) return { words: [text], alsoUnresolved: false };
  if (!charge(text.length + 1)) return TOO_COSTLY;
  return expandPass(text, groupsOf(text), charge);
}

/**
 * The pass over `text`: one linear pass, each group looked at in constant
 * time, but for a comma list (which ends the pass) or a candidate range.
 * A group holding no top-level comma but a group of its own and a `..` at
 * its own level, as a range would (f{1..{2,3}}), is read three ways, as
 * recorded: the reading before this one's (the pass goes on to the group
 * inside, and the words are read again: f1 f2 f1 f2 f3), bash 3.2's (the
 * group inside expanded, the outer braces dropped: f1..2 f1..3) and bash
 * 5's and zsh's (the outer braces kept as text: f{1..2} f{1..3}). Without
 * the `..`, every recorded shell keeps the outer braces as text
 * (f{a{b,c}}: f{ab} f{ac}), as the reading before this one's does.
 */
function expandPass(text: string, groups: Map<number, Group>, charge: (steps: number) => boolean): BraceExpansion | typeof TOO_COSTLY {
  const otherReadings: (() => BraceExpansion | typeof TOO_COSTLY)[] = [];
  const withOtherReadings = (expansion: BraceExpansion): BraceExpansion | typeof TOO_COSTLY => (otherReadings.length === 0 ? expansion : union([() => expansion, ...otherReadings]));
  for (let index = 0; index < text.length; index++) {
    if (index % CHARGE_EVERY === CHARGE_EVERY - 1 && !charge(0)) return TOO_COSTLY;
    if (text[index] === "\\") {
      index++;
      continue;
    }
    const found = text[index] === "{" ? groups.get(index) : undefined;
    if (found === undefined) continue;
    const before = text.slice(0, index);
    const after = text.slice(found.end + 1);
    if (found.commas.length === 0 && found.holdsGroup && found.rangeDots) {
      const inside = text.slice(index + 1, found.end);
      otherReadings.push(
        () => expandBraces(before + inside + after, charge),
        () => expandBraces(`${before}\\{${inside}\\}${after}`, charge),
      );
      continue;
    }
    let alternatives: readonly string[];
    let alsoUnresolved = false;
    if (found.commas.length > 0) alternatives = [...found.commas, found.end].map((comma, at, all) => text.slice(at === 0 ? index + 1 : (all[at - 1] ?? 0) + 1, comma));
    // A candidate range is sliced and tested only when it is short, or holds nothing a numeric range could not.
    else if (found.end - index - 1 <= MAX_RANGE_LENGTH || numericOnly(text, index + 1, found.end)) {
      const inside = text.slice(index + 1, found.end);
      if (!inside.includes("..") || inside.includes("\\")) continue;
      const range = rangeWords(inside);
      // A group that is no range stays as written, and the pass goes on to the next.
      if (range === NOT_A_RANGE) continue;
      alternatives = range.words;
      alsoUnresolved = range.alsoUnresolved;
    } else continue;
    const words: string[] = [];
    for (const alternative of alternatives) {
      const expanded = expandBraces(before + alternative + after, charge);
      if (expanded === TOO_COSTLY) return expanded;
      alsoUnresolved ||= expanded.alsoUnresolved;
      words.push(...expanded.words);
      // Past the cap the text is kept as written, a word still judged, and left to the shell too.
      if (words.length > MAX_WORDS) return withOtherReadings(asWritten(text));
    }
    return withOtherReadings({ words, alsoUnresolved });
  }
  return withOtherReadings({ words: [text], alsoUnresolved: false });
}
