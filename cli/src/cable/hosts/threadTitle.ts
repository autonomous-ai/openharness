// The title of ChatGPT's window, which Harness Device tells the dial to follow. The watch loads this file, so it imports
// nothing. Its two rules are Harness Device's own (follow.rs): at most 256 UTF-16 units (Rust counts `encode_utf16`,
// a JavaScript string's `length` is the same) and no Unicode Cc character (Rust's `char::is_control`), so the two sides
// never disagree on a title.

export const THREAD_TITLE_MAX = 256

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** The title itself when it keeps both rules (the empty title does), else null. */
export function threadTitleOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > THREAD_TITLE_MAX || CONTROL.test(value)) return null
  return value
}
