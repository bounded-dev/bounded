// Bash's brace expansion of literal text, done statically: comma lists
// ({a,b}) and simple ranges ({1..3}, {a..e}), nested, left to right. Text
// keeps its backslash escapes, which make a character literal (quoted text
// arrives escaped, so it never expands). More than MAX_WORDS words is more
// than this will spell out. Each pass over a text is linear in its length,
// and every pass is charged to `charge`: when it refuses, the expansion
// stops, too costly to finish.

const MAX_WORDS = 256;

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
 * `text` brace-expanded; undefined when it would give more than MAX_WORDS
 * words; TOO_COSTLY when `charge`, given each pass's length, refuses.
 */
export function expandBraces(text: string, charge: (steps: number) => boolean): string[] | undefined | typeof TOO_COSTLY {
  if (!charge(text.length + 1)) return TOO_COSTLY;
  if (!text.includes("{")) return [text];
  const groups = groupsOf(text);
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    const found = text[index] === "{" ? groups.get(index) : undefined;
    if (found === undefined) continue;
    const inside = text.slice(index + 1, found.end);
    const parts = found.commas.length === 0 ? [inside] : [...found.commas, found.end].map((comma, at, all) => text.slice(at === 0 ? index + 1 : (all[at - 1] ?? 0) + 1, comma));
    const alternatives = parts.length > 1 ? parts : /^[^\\]*\.\.[^\\]*$/.test(inside) ? range(inside) : [];
    if (alternatives === undefined) return /^(-?\d+\.\.-?\d+|[a-zA-Z]\.\.[a-zA-Z])$/.test(inside) ? undefined : [text];
    if (alternatives.length === 0) continue;
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
