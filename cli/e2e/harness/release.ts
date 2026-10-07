/**
 * A release of this checkout at a made-up version, as the update and re-execution tests serve them: the
 * bundle built once, with its version swapped. The version is baked in at build time, in cli.js and in
 * the lean bundle cli.js carries for harnessd's master, its services and its core (src/harnessd/leanBundle.ts),
 * so it is swapped in both: a master reporting the build before is not the build it was handed.
 */
import { LEAN_CORE_ENTRY, LEAN_ENTRY, readLeanBundle } from '../../src/harnessd/leanBundle.js'

const { LEAN_MARKER, leanBlock } = await import('../../scripts/lib/leanBlock.mjs' as string) as {
  LEAN_MARKER: string
  leanBlock: (files: Record<string, string | Uint8Array>, options?: { quality: number }) => string
}

// The October 7 full E2E run exhausted updateHostile's five-minute setup compressing 15 made-up
// releases at Brotli's maximum quality after the lean-core extraction. Fixtures need identical
// decoded files and checksums, not release download sizes. The build still uses quality 11.
const FIXTURE_COMPRESSION = { quality: 4 }

/** [bundle] (cli.js's text) with every [from] made [to], in the lean bundle it carries too. */
export function atVersion(bundle: string, from: string, to: string): string {
  const lean = readLeanBundle(Buffer.from(bundle))
  if (!lean) return bundle.replaceAll(from, to)
  const head = bundle.slice(0, bundle.lastIndexOf(LEAN_MARKER)).replace(/\n$/, '')
  const files = Object.fromEntries([...lean.files].map(([name, code]) => [name, code.toString('utf8').replaceAll(from, to)]))
  return head.replaceAll(from, to) + leanBlock(files, FIXTURE_COMPRESSION)
}

/** [bundle] carrying [files] as its lean bundle instead of its own: a lean bundle that misbehaves. */
export function withLean(bundle: string, files: Record<string, string>): string {
  const at = bundle.lastIndexOf(LEAN_MARKER)
  const head = at < 0 ? bundle : bundle.slice(0, at).replace(/\n$/, '')
  return head + leanBlock(files, FIXTURE_COMPRESSION)
}

/**
 * [bundle] with [code] run first wherever a daemon process starts on it: after cli.js's first line, and
 * at the top of the lean bundle's two entries: the one the master re-executes on and starts the services
 * from (src/leanEntry.ts), and the core's (src/leanCoreEntry.ts). A fault aimed at the core
 * (`process.argv[2]==="__run"`) must reach a core started from either file, as a build whose core
 * crashes does.
 */
export function withFault(bundle: string, code: string): string {
  if (!code) return bundle
  const inCli = bundle.replace('\n', `\n${code}\n`)
  const lean = readLeanBundle(Buffer.from(inCli))
  if (!lean) return inCli
  const files = Object.fromEntries([...lean.files].map(([name, text]) => [name, text.toString('utf8')]))
  for (const entry of [LEAN_ENTRY, LEAN_CORE_ENTRY]) if (files[entry]) files[entry] = files[entry]!.replace('\n', `\n${code}\n`)
  return withLean(inCli, files)
}
