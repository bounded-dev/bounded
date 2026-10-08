/**
 * Whether two values have the same wire form (their JSON): how a value
 * object made of other values compares by value. Each one's `toJSON` is a
 * function of its fields alone, so equal fields give equal text.
 */
export function sameWire(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A value object's wire form, read again so its parse can check it: a
 * value made by calling the class's constructor directly was never checked.
 * Undefined, and so refused, when its toJSON cannot run.
 */
export function wireFormOf(value: { toJSON(): unknown }): unknown {
  try {
    return value.toJSON();
  } catch {
    return undefined;
  }
}
