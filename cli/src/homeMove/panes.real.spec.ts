import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildHarnessSessionLabel, paneOwnerFormat } from '../lib/harnessSessionLabel.js'
import { TmuxBackend } from '../lib/tmuxBackend.js'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import type { Done } from './journal.js'
import { defaultTmux } from './panes.js'

const OLD = '0123456789abcdef', NEW = 'fedcba9876543210'
const realDescribe = process.env.RUN_REAL_TMUX_DISCOVERY === '1' ? describe : describe.skip
let server: IsolatedTmux

/** Every pane's id and tag, as the daemon lists them. */
async function tagged(): Promise<string[]> {
  return (await server.run('list-panes', '-a', '-F', `#{pane_id}|${paneOwnerFormat(true)}`)).split('\n')
}

realDescribe.sequential('the move retags panes on a real tmux', () => {
  beforeAll(async () => {
    server = await isolatedTmux()
    // The default server of everything below is this private one, never the developer's.
    vi.stubEnv('TMUX_TMPDIR', server.root)
    vi.stubEnv('TMUX', undefined)
    vi.stubEnv('TMUX_PANE', undefined)
    // Started with the fixture's environment and no config, before the backend's first bare call could start it.
    await server.run('new-session', '-d', '-s', 'keeper', 'sleep 600')
  })

  afterAll(async () => {
    try { await server?.close() } finally { vi.unstubAllEnvs() }
  })

  it('a pane created as the daemon creates it is retagged, and a listing reads the new tag', async () => {
    const created = await new TmuxBackend(undefined, () => OLD, () => {}).create({ label: buildHarnessSessionLabel('claude'), command: ['sleep', '600'] })
    if (created.state !== 'succeeded') throw new Error(`the pane was not created: ${created.state}`)
    const pane = created.runtime.paneId
    expect(await tagged()).toContain(`${pane}|${OLD}`)
    const done: Done[] = []
    expect(defaultTmux().retag(OLD, NEW, { add: (step) => done.push(step) })).toEqual([pane])
    expect(await tagged()).toContain(`${pane}|${NEW}`)
    expect(done).toEqual([{ did: 'pane', id: pane }])
    defaultTmux().tag([pane], OLD)
    expect(await tagged()).toContain(`${pane}|${OLD}`)
  })

  it('a tag set on the window is overridden on the pane, and the window keeps its own', async () => {
    const pane = await server.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', buildHarnessSessionLabel('codex'), 'sleep 600')
    await server.run('set-option', '-w', '-t', pane, '@harness_daemon', OLD)
    expect(defaultTmux().retag(OLD, NEW, { add: () => {} })).toContain(pane)
    expect(await tagged()).toContain(`${pane}|${NEW}`)
    expect(await server.run('show-options', '-w', '-v', '-t', pane, '@harness_daemon')).toBe(OLD)
  })
})
