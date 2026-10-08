// Bash's brace expansion of literal text, done statically: comma lists
// ({a,b}) and simple ranges ({1..3}, {a..e}), nested, left to right. Text
// keeps its backslash escapes, which make a character literal. More than
// MAX_WORDS words is more than this will spell out.

const MAX_WORDS = 256;

/** The top-level parts of the brace group opening at `start`, and where it closes; undefined when it does not close. */
function group(text: string, start: number): { readonly end: number; readonly parts: string[] } | undefined {
  let depth = 0;
  let from = start + 1;
  const parts: string[] = [];
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return { end: index, parts: [...parts, text.slice(from, index)] };
    else if (char === "," && depth === 1) {
      parts.push(text.slice(from, index));
      from = index + 1;
    }
  }
  return undefined;
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

/** `text` brace-expanded; undefined when it would give more than MAX_WORDS words. */
export function expandBraces(text: string): string[] | undefined {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] !== "{") continue;
    const found = group(text, index);
    if (found === undefined) continue;
    const inside = text.slice(index + 1, found.end);
    const alternatives = found.parts.length > 1 ? found.parts : /^[^\\]*\.\.[^\\]*$/.test(inside) ? range(inside) : [];
    if (alternatives === undefined) return /^(-?\d+\.\.-?\d+|[a-zA-Z]\.\.[a-zA-Z])$/.test(inside) ? undefined : [text];
    if (alternatives.length === 0) continue;
    const out: string[] = [];
    for (const alternative of alternatives) {
      const expanded = expandBraces(text.slice(0, index) + alternative + text.slice(found.end + 1));
      if (expanded === undefined) return undefined;
      out.push(...expanded);
      if (out.length > MAX_WORDS) return undefined;
    }
    return out;
  }
  return [text];
}
