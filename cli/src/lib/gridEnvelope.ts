/**
 * The refusal envelope `grid --json` writes on stderr beside its plain sentence, one JSON line:
 * `{"error": {"code", "message", "status"}}` (autonomous-grid `cli/json_error.py`). Grid reads compare
 * its `code` (`gridReader.ts`); the sign-in hand-off shows its `message` (`gridHandoff.ts`). ⚠️ That
 * message is a subprocess's text on a person's screen, so control characters become spaces and it is
 * bounded; the `code` is compared, never shown, and is left exactly as sent.
 */
export interface GridEnvelope { code: string | null; message: string | null }

/** Fits `grid`'s rendering of a control-plane refusal (request line ~70 + ≤400 chars of reply). */
const MAX_MESSAGE_CHARS = 600
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]+/gu // C0 (newline, tab), DEL, C1 (CSI), and invisible/bidi format

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function displayable(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // By code point, so a cut never leaves half a surrogate pair.
  const chars = Array.from(value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim())
  if (!chars.length) return null
  return chars.length > MAX_MESSAGE_CHARS ? `${chars.slice(0, MAX_MESSAGE_CHARS - 1).join('')}…` : chars.join('')
}

/** Every envelope on `stderr`, in the order written. Any other line — the plain sentence, a warning — is
 *  skipped: the envelope is an addition to a shared stream, never the whole of it. */
export function gridEnvelopes(stderr: string): GridEnvelope[] {
  return stderr.split('\n').flatMap((line) => {
    let parsed: unknown
    try { parsed = line.trim().startsWith('{') ? JSON.parse(line.trim()) : null } catch { return [] }
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : null
    return error ? [{ code: typeof error.code === 'string' ? error.code : null, message: displayable(error.message) }] : []
  })
}
