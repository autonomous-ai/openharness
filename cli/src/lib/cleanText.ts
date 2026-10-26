/** Untrusted display text: remove controls and format characters (including bidi overrides), then bound its size. */
export function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, max) : ''
}
