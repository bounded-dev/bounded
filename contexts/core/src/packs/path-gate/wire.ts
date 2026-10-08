/** Whether two rules have the same wire form. */
export const sameWire = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A rule's wire form, read again so parse can check it; undefined, and so refused, when it cannot be read. */
export function wireFormOf(value: { toJSON(): unknown }): unknown {
  try {
    return value.toJSON();
  } catch {
    return undefined;
  }
}
