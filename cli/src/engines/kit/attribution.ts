/** Optional instruction parsing belongs to engineSetup; the core receives only a bounded value. */
import { dirname, join, parse, resolve } from 'node:path'
import type { InstructionConfig } from '../facets/launch.js'
import { topLevelEntry } from './launchArgs.js'

export interface AttributionFiles {
  /** The engine's home for this launch: the person's own settings are in it. */
  home: string
  /** The person's home folder: a folder's own config is looked for up to it, never in it. */
  personal: string
  /** The harness's folder, or null where it has none. */
  cwd: string | null
  /** A file's text, or null when it is absent or cannot be read. */
  read: (path: string) => string | null
}

export interface Instruction { text: string; mark: string }

/** A prepared value, without command-line authority, for the setup worker's captured sources. */
export function instructionValueIn(contract: InstructionConfig, instructions: readonly Instruction[], files: AttributionFiles): string | null {
  const config = join(files.home, contract.file)
  // A folder's own config: the engine reads it over the person's, and `-c` would replace it. Left alone. Looked for
  // up to the home folder, not in it: `~/.codex/config.toml` is the person's own config, not a folder's.
  if (files.cwd) {
    const personal = resolve(files.personal)
    for (let dir = resolve(files.cwd); dir !== personal && dir !== parse(dir).root; dir = dirname(dir)) {
      const path = join(dir, contract.folder)
      if (path === config) continue
      const toml = files.read(path)
      if (toml !== null && topLevelEntry(toml, contract.key).state !== 'absent') return null
    }
  }
  const toml = files.read(config)
  const theirs = toml === null ? { state: 'absent' as const } : topLevelEntry(toml, contract.key)
  if (theirs.state === 'unreadable') return null
  // What their value holds already is not said twice.
  const ours = instructions.filter(({ mark }) => !(theirs.state === 'set' && theirs.value.includes(mark)))
  if (!ours.length) return null
  const instruction = ours.map(({ text }) => text).join('\n\n')
  const value = theirs.state === 'set' && theirs.value ? `${theirs.value}\n\n${instruction}` : instruction
  return value
}
