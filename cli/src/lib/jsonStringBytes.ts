/** Exact JSON string bytes, including quotes, or null when the byte budget is exceeded. */
export function jsonStringBytes(value: string, limit: number): number | null {
  // Counting dominated legal maximum-frame profiles; one native string codec avoids repeated escape scans.
  // UTF-16 length is a lower bound, so even an unbounded inline value is refused before a native scan.
  const remaining = limit - 2
  if (value.length > remaining) return null
  const utf8 = Buffer.byteLength(value)
  if (utf8 > remaining) return null
  let bytes = 2
  if (!/["\\\u0000-\u001f\ud800-\udfff]/.test(value)) return (bytes += utf8) <= limit ? bytes : null
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 4096, value.length)
    const high = value.charCodeAt(end - 1)
    if (high >= 0xd800 && high <= 0xdbff) {
      const low = value.charCodeAt(end)
      if (low >= 0xdc00 && low <= 0xdfff) end--
    }
    // Only a primitive string reaches stringify: at most 6 * 4096 + 2 bytes, with no toJSON lookup.
    // Keeping pairs together makes concatenated fragment contents equal the whole JSON string.
    if (!((bytes += Buffer.byteLength(JSON.stringify(value.slice(start, end))) - 2) <= limit)) return null
    start = end
  }
  return bytes
}
