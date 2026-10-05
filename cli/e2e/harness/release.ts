/**
 * A release of this checkout at a made-up version, as the update and re-execution tests serve them: the
 * bundle built once, with its version swapped. The version is baked in at build time, in cli.js and in
 * the lean bundle cli.js carries for harnessd's master and its services (src/lib/leanBundle.ts), so it
 * is swapped in both: a master reporting the build before is not the build it was handed.
 */
import { readLeanBundle } from '../../src/lib/leanBundle.js'

const { LEAN_MARKER, leanBlock } = await import('../../scripts/lib/leanBlock.mjs' as string) as {
  LEAN_MARKER: string
  leanBlock: (code: string | Uint8Array) => string
}

/** [bundle] (cli.js's text) with every [from] made [to], in the lean bundle it carries too. */
export function atVersion(bundle: string, from: string, to: string): string {
  const lean = readLeanBundle(Buffer.from(bundle))
  if (!lean) return bundle.replaceAll(from, to)
  const head = bundle.slice(0, bundle.lastIndexOf(LEAN_MARKER)).replace(/\n$/, '')
  return head.replaceAll(from, to) + leanBlock(lean.code.toString('utf8').replaceAll(from, to))
}

/** [bundle] carrying [code] as its lean bundle instead of its own: a lean bundle that misbehaves. */
export function withLean(bundle: string, code: string): string {
  const at = bundle.lastIndexOf(LEAN_MARKER)
  const head = at < 0 ? bundle : bundle.slice(0, at).replace(/\n$/, '')
  return head + leanBlock(code)
}
