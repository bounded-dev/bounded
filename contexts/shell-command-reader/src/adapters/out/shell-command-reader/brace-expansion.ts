// Bash's brace expansion of literal text, done statically: comma lists
// ({a,b}) and ranges ({1..3}, {a..e}, {01..10}, {1..9..2}), nested, left to
// right. Text keeps its backslash escapes, which make a character literal
// (quoted text arrives escaped, so it never expands). More than MAX_WORDS
// words is more than this will spell out. Each pass over a text is linear in
// its length, and every pass is charged to `charge`: when it refuses, the
// expansion stops, too costly to finish.

const MAX_WORDS = 256;
/** The longest group sliced as a candidate range whatever it holds ({-2147483648..2147483647..1} is 27 characters); a longer one only when it holds nothing a numeric range could not. */
const MAX_RANGE_LENGTH = 48;
/** A numeric range's whole text, with its optional step: anchored, no nested quantifiers, so it backtracks at most linearly. */
const NUMERIC_RANGE = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/;
/** A letter range's whole text, with its optional step. */
const LETTER_RANGE = /^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/;
/** How many characters a pass goes between two charges of nothing, which look at the time. */
export const CHARGE_EVERY = 4096;

/** What brace expansion gives when it costs more than it was allowed. */
export const TOO_COSTLY = "too-costly" as const;

/** What rangeWords gives for a group that is no range. */
const NOT_A_RANGE = "not-a-range" as const;

/** A brace group in a text: where it closes, and where its top-level commas are. */
interface Group {
  readonly end: number;
  readonly commas: readonly number[];
}

/** Every brace group in `text` that closes, by where it opens: one pass with a stack, escapes skipped. */
function groupsOf(text: string): Map<number, Group> {
  const groups = new Map<number, Group>();
  const open: { readonly start: number; readonly commas: number[] }[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "{") open.push({ start: index, commas: [] });
    else if (char === "," && open.length > 0) open.at(-1)?.commas.push(index);
    else if (char === "}") {
      const closed = open.pop();
      if (closed !== undefined) groups.set(closed.start, { end: index, commas: closed.commas });
    }
  }
  return groups;
}

/** `text` with every character that could expand escaped, so a range's word, or a group kept as written, stays literal. */
const escaped = (text: string): string => text.replace(/[\\{},.]/g, "\\$&");

/** Whether a range's end is written zero-padded (01, 007, -05): bash 4 and zsh then pad every word to the longer end's width. */
const zeroPaddedEnd = (end: string): boolean => /^-?0\d/.test(end);

/**
 * The words of a range group, given its inside, every way a shell could
 * expand it, escaped; NOT_A_RANGE when it is no range, and undefined
 * (unresolved) when it is one this will not spell out. Bash 3.2 neither
 * pads nor steps; bash 4 and zsh do; every reading is given, so each path
 * either shell could touch is judged:
 * - {01..03} gives 01 02 03 (bash 4, zsh) and 1 2 3 (bash 3.2);
 * - {1..5..2} gives 1 3 5 (bash 4, zsh) and the group as written (bash 3.2
 *   keeps it literal).
 * Unresolved: a step of zero or below (the shells disagree on its words),
 * a zero-padded range with a negative end (they disagree on its width), an
 * end or step past the integers held exactly, or more than MAX_WORDS words.
 */
function rangeWords(inside: string): string[] | undefined | typeof NOT_A_RANGE {
  const numbers = NUMERIC_RANGE.exec(inside);
  const letters = numbers === null ? LETTER_RANGE.exec(inside) : null;
  const parts = numbers ?? letters;
  if (parts === null) return NOT_A_RANGE;
  const [, fromText = "", toText = "", stepText] = parts;
  const [from, to] = numbers !== null ? [Number(fromText), Number(toText)] : [fromText.charCodeAt(0), toText.charCodeAt(0)];
  const step = stepText === undefined ? 1 : Number(stepText);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isSafeInteger(step) || step <= 0) return undefined;
  if (Math.floor(Math.abs(to - from) / step) >= MAX_WORDS) return undefined;
  const zeroPadded = numbers !== null && (zeroPaddedEnd(fromText) || zeroPaddedEnd(toText));
  if (zeroPadded && (from < 0 || to < 0)) return undefined;
  const width = Math.max(fromText.length, toText.length);
  const direction = from <= to ? 1 : -1;
  const words = new Set<string>();
  for (let at = from; direction > 0 ? at <= to : at >= to; at += direction * step) {
    const word = numbers !== null ? String(at) : String.fromCharCode(at);
    words.add(escaped(word));
    if (zeroPadded) words.add(word.padStart(width, "0"));
  }
  // Bash 3.2 has no step: there the group stays as written.
  if (stepText !== undefined) words.add(escaped(`{${inside}}`));
  return [...words];
}

/**
 * Whether `text` from `from` to `to` holds only digits, dots and minus signs
 * with a `..` among them: it could be a numeric range. It stops at the first
 * other character, so nested groups (which start with one) cost constant
 * time each; a group it passes whole holds no other group, so the groups it
 * lets be sliced never overlap, and a pass stays linear.
 */
function numericOnly(text: string, from: number, to: number): boolean {
  let dots = false;
  for (let index = from; index < to; index++) {
    const char = text.charCodeAt(index);
    if (char === 46) dots ||= text.charCodeAt(index + 1) === 46;
    else if (char !== 45 && (char < 48 || char > 57)) return false;
  }
  return dots;
}

/**
 * `text` brace-expanded; undefined when it would give more than MAX_WORDS
 * words, or holds a range this will not spell out; TOO_COSTLY when
 * `charge`, given each pass's length and nothing every CHARGE_EVERY
 * characters within one, refuses.
 */
export function expandBraces(text: string, charge: (steps: number) => boolean): string[] | undefined | typeof TOO_COSTLY {
  // Text with no brace has nothing to expand: one scan, and nothing charged.
  if (!text.includes("{")) return [text];
  if (!charge(text.length + 1)) return TOO_COSTLY;
  const groups = groupsOf(text);
  // One linear pass: each group is looked at in constant time, but for a comma list (which ends the pass) or a candidate range.
  for (let index = 0; index < text.length; index++) {
    if (index % CHARGE_EVERY === CHARGE_EVERY - 1 && !charge(0)) return TOO_COSTLY;
    if (text[index] === "\\") {
      index++;
      continue;
    }
    const found = text[index] === "{" ? groups.get(index) : undefined;
    if (found === undefined) continue;
    let alternatives: string[] | undefined | typeof NOT_A_RANGE;
    if (found.commas.length > 0) alternatives = [...found.commas, found.end].map((comma, at, all) => text.slice(at === 0 ? index + 1 : (all[at - 1] ?? 0) + 1, comma));
    // A candidate range is sliced and tested only when it is short, or holds nothing a numeric range could not.
    else if (found.end - index - 1 <= MAX_RANGE_LENGTH || numericOnly(text, index + 1, found.end)) {
      const inside = text.slice(index + 1, found.end);
      if (!inside.includes("..") || inside.includes("\\")) continue;
      alternatives = rangeWords(inside);
      // A range this will not spell out only the shell can say; a group that is no range stays as written, and the pass goes on to the next.
      if (alternatives === undefined) return undefined;
      if (alternatives === NOT_A_RANGE) continue;
    } else continue;
    const out: string[] = [];
    for (const alternative of alternatives) {
      const expanded = expandBraces(text.slice(0, index) + alternative + text.slice(found.end + 1), charge);
      if (expanded === undefined || expanded === TOO_COSTLY) return expanded;
      out.push(...expanded);
      if (out.length > MAX_WORDS) return undefined;
    }
    return out;
  }
  return [text];
}
