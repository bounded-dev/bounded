/**
 * Whether two values have the same wire form (their JSON): how a value
 * object made of other values compares by value. Each one's `toJSON` is a
 * function of its fields alone, so equal fields give equal text.
 */
export function sameWire(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
