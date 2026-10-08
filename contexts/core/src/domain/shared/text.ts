/** Whether `text` holds a control character (C0 or DEL) other than those in `allowed`. */
export function hasControl(text: string, allowed = ""): boolean {
  return [...text].some((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) && !allowed.includes(c));
}
