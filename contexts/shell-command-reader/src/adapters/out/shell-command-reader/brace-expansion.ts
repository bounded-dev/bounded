// Bash's brace expansion of literal text, done statically: comma lists
// ({a,b}) and simple ranges ({1..3}, {a..e}), nested, left to right. Text
// keeps its backslash escapes, which make a character literal (quoted text
// arrives escaped, so it never expands). More than MAX_WORDS words is more
// than this will spell out. Each pass over a text is linear in its length,
// and every pass is charged to `charge`: when it refuses, the expansion
// stops, too costly to finish.

const MAX_WORDS = 256;
/** The longest group that could be a range ({-2147483648..2147483647} is 25 characters): longer ones are never sliced or tested. */
const MAX_RANGE_LENGTH = 48;
/** A range's whole text: anchored, with no nested quantifiers, so it cannot backtrack. */
const RANGE = /^(-?\d+\.\.-?\d+|[a-zA-Z]\.\.[a-zA-Z])$/;
/** How many characters a pass goes between two charges of nothing, which look at the time. */
const CHARGE_EVERY = 4096;

/** What brace expansion gives when it costs more than it was allowed. */
export const TOO_COSTLY = "too-costly" as const;

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

/** The words of a range ({1..3}, {a..e}), or undefined when it is not one, or too long. */
function range(inside: string): string[] | undefined {
  const numbers = /^(-?\d+)\.\.(-?\d+)$/.exec(inside);
  const letters = /^([a-zA-Z])\.\.([a-zA-Z])$/.exec(inside);
  const [from, to, letter] = numbers !== null ? [Number(numbers[1]), Number(numbers[2]), false] : letters !== null ? [letters[1]?.charCodeAt(0) ?? 0, letters[2]?.charCodeAt(0) ?? 0, true] : [0, 0, undefined];
  if (letter === undefined || Math.abs(to - from) >= MAX_WORDS) return undefined;
  const step = from <= to ? 1 : -1;
  const out: string[] = [];
  for (let at = from; step > 0 ? at <= to : at >= to; at += step) out.push(letter ? String.fromCharCode(at) : String(at));
  return out;
}

/**
 * Whether `text` from `from` to `to` holds only digits, dots and minus signs
 * with a `..` among them: a numeric range. It stops at the first other
 * character, so nested groups (which start with one) cost constant time
 * each and a pass stays linear.
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
 * words; TOO_COSTLY when `charge`, given each pass's length, refuses.
 */
export function expandBraces(text: string, charge: (steps: number) => boolean): string[] | undefined | typeof TOO_COSTLY {
  // Text with no brace has nothing to expand: one scan, and nothing charged.
  if (!text.includes("{")) return [text];
  if (!charge(text.length + 1)) return TOO_COSTLY;
  const groups = groupsOf(text);
  // One linear pass: each group is looked at in constant time, but for a comma list (which ends the pass) or a short candidate range.
  for (let index = 0; index < text.length; index++) {
    if (index % CHARGE_EVERY === CHARGE_EVERY - 1 && !charge(0)) return TOO_COSTLY;
    if (text[index] === "\\") {
      index++;
      continue;
    }
    const found = text[index] === "{" ? groups.get(index) : undefined;
    if (found === undefined) continue;
    const length = found.end - index - 1;
    let alternatives: string[] | undefined;
    if (found.commas.length > 0) alternatives = [...found.commas, found.end].map((comma, at, all) => text.slice(at === 0 ? index + 1 : (all[at - 1] ?? 0) + 1, comma));
    else if (length <= MAX_RANGE_LENGTH) {
      // A range is short ({1..3}, {a..e}): only a short group is sliced and tested, and with anchored patterns that cannot backtrack.
      const inside = text.slice(index + 1, found.end);
      if (!inside.includes("..") || inside.includes("\\")) continue;
      alternatives = range(inside);
      if (alternatives === undefined) return RANGE.test(inside) ? undefined : [text];
    } else if (numericOnly(text, index + 1, found.end)) return undefined; // a range far too long to spell out: only the shell can say
    else continue;
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
