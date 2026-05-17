/**
 * Spec-compliant CSS.escape polyfill for Node.
 * Implements CSS-OM Living Standard §6.5 (CSS.escape).
 *
 * Node does not expose the DOM `CSS` global, so any `CSS.escape(...)` call
 * in Node-side code throws `ReferenceError: CSS is not defined`. This module
 * replaces those calls.
 */
export function cssEscape(value: string): string {
  const s = String(value);
  const length = s.length;
  let result = '';
  let firstCharCode = 0;

  for (let i = 0; i < length; i++) {
    const c = s.charCodeAt(i);

    if (c === 0x0000) {
      result += '�';
      continue;
    }

    if (
      (c >= 0x0001 && c <= 0x001f) ||
      c === 0x007f ||
      (i === 0 && c >= 0x0030 && c <= 0x0039) ||
      (i === 1 && c >= 0x0030 && c <= 0x0039 && firstCharCode === 0x002d)
    ) {
      result += '\\' + c.toString(16) + ' ';
      if (i === 0) firstCharCode = c;
      continue;
    }

    if (i === 0 && length === 1 && c === 0x002d) {
      result += '\\' + s.charAt(i);
      continue;
    }

    if (
      c >= 0x0080 ||
      c === 0x002d ||
      c === 0x005f ||
      (c >= 0x0030 && c <= 0x0039) ||
      (c >= 0x0041 && c <= 0x005a) ||
      (c >= 0x0061 && c <= 0x007a)
    ) {
      result += s.charAt(i);
      if (i === 0) firstCharCode = c;
      continue;
    }

    result += '\\' + s.charAt(i);
    if (i === 0) firstCharCode = c;
  }

  return result;
}
