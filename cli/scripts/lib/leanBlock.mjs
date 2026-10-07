/**
 * The lean bundle cli.js carries (src/harnessd/leanBundle.ts reads it back).
 *
 * harnessd's master and its services each run in a process of their own, and a process started on the
 * whole 4.4 MB cli.js paid about 45 MiB just for Node to parse it, whatever it ran. So the build bundles
 * the master and the services a second time on their own (src/leanEntry.ts), split so that each process
 * parses only the files its own code is in, and appends those files to cli.js as a comment, which Node
 * only skims. The master writes them out and runs itself and the services from them. The release is
 * still the one cli.js the updater downloads, verifies and swaps, so a lean bundle is always the one
 * built with the cli.js that carries it.
 *
 * The comment holds the sha256 of the files, as one JSON object of name to code, and that JSON,
 * brotli-compressed and base64-encoded: base64 never contains the `*` and `/` that would end a comment.
 */
import { createHash } from 'node:crypto'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'

/** Where the lean bundle starts, at the very end of cli.js. src/harnessd/leanBundle.ts looks for it. */
export const LEAN_MARKER = '/*@harness-lean:'

/** The comment that carries [files] (file name to code), to append to cli.js. */
export function leanBlock(files, { quality = 11 } = {}) {
  const named = Object.fromEntries(Object.entries(files).map(([name, code]) => [name, Buffer.from(code).toString('utf8')]))
  const payload = Buffer.from(JSON.stringify(named))
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const packed = brotliCompressSync(payload, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } }).toString('base64')
  return `\n${LEAN_MARKER}${sha256}:${packed}*/\n`
}

/**
 * The files the comment at the end of [bundle] (cli.js's bytes) carries, by name; null when it carries
 * none or one that does not match its checksum. For the release script's check
 * (scripts/check-lean-bundle.mjs); the daemon reads it with src/harnessd/leanBundle.ts.
 */
export function readLeanBlock(bundle) {
  const text = Buffer.from(bundle).toString('latin1')
  const start = text.lastIndexOf(LEAN_MARKER)
  if (start < 0) return null
  const end = text.indexOf('*/', start)
  if (end < 0 || text.slice(end + 2).trim() !== '') return null
  const body = text.slice(start + LEAN_MARKER.length, end)
  const [sha256, packed] = body.split(':')
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? '') || !packed) return null
  let payload
  try { payload = brotliDecompressSync(Buffer.from(packed, 'base64')) } catch { return null }
  if (createHash('sha256').update(payload).digest('hex') !== sha256) return null
  return JSON.parse(payload.toString('utf8'))
}
