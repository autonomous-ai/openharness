/**
 * The lean bundle cli.js carries (src/lib/leanBundle.ts reads it back).
 *
 * harnessd's master and its services each run in a process of their own, and a process started on the
 * whole 4.4 MB cli.js paid about 45 MiB just for Node to parse it, whatever it ran. So the build bundles
 * the master and the services a second time on their own (src/leanEntry.ts, under 1 MB), and appends
 * that bundle to cli.js as a comment, which Node only skims. The master writes it out and runs itself
 * and the services from it. The release is still the one cli.js the updater downloads, verifies and
 * swaps, so a lean bundle is always the one built with the cli.js that carries it.
 *
 * The comment holds the bundle's sha256 and its bytes, brotli-compressed and base64-encoded: base64
 * never contains the `*` and `/` that would end a comment.
 */
import { createHash } from 'node:crypto'
import { brotliCompressSync, constants } from 'node:zlib'

/** Where the lean bundle starts, at the very end of cli.js. src/lib/leanBundle.ts looks for it. */
export const LEAN_MARKER = '/*@harness-lean:'

/** The comment that carries [code], to append to cli.js. */
export function leanBlock(code) {
  const bytes = Buffer.from(code)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const packed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).toString('base64')
  return `\n${LEAN_MARKER}${sha256}:${packed}*/\n`
}
