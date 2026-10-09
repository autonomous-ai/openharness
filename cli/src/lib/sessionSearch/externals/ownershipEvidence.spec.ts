import { expect, it } from 'vitest'
import { externalEvidence } from '../evidence.js'
import { opencodeProvider } from './opencode.js'
import { piProvider } from './pi.js'
import { commandcodeProvider } from './commandcode.js'
import { museProvider } from './muse.js'
import type { ExternalProvider, ProcessView } from './types.js'

const providers: Array<[string, () => ExternalProvider]> = [
  ['opencode', () => opencodeProvider({ engine: 'opencode', dbPath: '/fixture/store.db' })],
  ['kilo', () => opencodeProvider({ engine: 'kilo', dbPath: '/fixture/store.db' })],
  ['pi', () => piProvider({ agentDir: '/fixture/pi' })],
  ['commandcode', () => commandcodeProvider({ home: '/fixture/commandcode' })],
  ['muse', () => museProvider({ home: '/fixture/muse' })],
]
it.each(providers)('%s launch arguments cannot establish that another conversation is free', async (engine, create) => {
  const provider = create()
  for (const suffix of ['', '--resume 11111111-1111-4111-8111-111111111111']) {
    const view: ProcessView = { list: async () => [{ pid: 501, ppid: 1, executable: engine, args: `${engine} ${suffix}` }],
      alive: () => true, openFiles: async () => new Map(), cwds: async () => new Map(), openFilesOf: async () => new Map() }
    expect(await externalEvidence(() => provider.owners!(view)), suffix).toMatchObject({ ok: false })
    // The display reader may still show the original argv claim; strict admission never uses it as absence.
    await expect(provider.owners!(view)).resolves.toBeInstanceOf(Array)
    expect(await externalEvidence(() => provider.owners!({ ...view, list: async () => [] }))).toEqual({ ok: true, value: [] })
  }
})
