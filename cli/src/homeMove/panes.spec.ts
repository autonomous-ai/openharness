import { afterEach, describe, expect, it, vi } from 'vitest'
import { paneOwnerFormat } from '../lib/harnessSessionLabel.js'
import { atLeast, parseTmuxVersion, TMUX_FEATURE_MIN } from '../lib/tmuxVersion.js'
import type { Done } from './journal.js'
import { defaultTmux, hasPaneOptions } from './panes.js'

const OLD = '0123456789abcdef', NEW = 'fedcba9876543210', OTHER = 'aaaaaaaaaaaaaaaa'
const LISTING = ['list-panes', '-a', '-F', `#{pane_id}|${paneOwnerFormat(true)}`]
const setTag = (id: string, tag: string): string[] => ['set-option', '-p', '-t', id, '@harness_daemon', tag]

// The default run is the only one that reaches spawnSync: answered here, so no test asks the developer's tmux.
const spawned = vi.hoisted(() => vi.fn((_command: string, args: readonly string[], _options: object) =>
  args[0] === '-V' ? { status: 0, stdout: 'tmux 3.4\n' }
    : args[0] === 'list-panes' ? { status: 0, stdout: '%1|0123456789abcdef\n' } : { status: 0, stdout: '' }))
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawnSync: spawned }))

/** A tmux that lists [panes] as given, sets a tag on any pane but the [gone] ones, and records every call. */
function fakeTmux({ version = 'tmux 3.4', panes = '', gone = [] as string[], installed = true, server = true } = {}) {
  const calls: string[][] = []
  const run = (args: string[]): { status: number | null; stdout: string } => {
    calls.push(args)
    if (!installed) return { status: null, stdout: '' }
    if (args[0] === '-V') return { status: 0, stdout: `${version}\n` }
    if (!server) return { status: 1, stdout: '' }
    if (args[0] === 'list-panes') return { status: 0, stdout: panes }
    if (args[0] === 'set-option') return { status: gone.includes(args[3]) ? 1 : 0, stdout: '' }
    return { status: 1, stdout: '' }
  }
  return { calls, run }
}

function journal(): { done: Done[]; add(done: Done): void } {
  const done: Done[] = []
  return { done, add: (step) => done.push(step) }
}

afterEach(() => {
  vi.unstubAllEnvs()
  spawned.mockClear()
})

describe('the move retags Harness\'s panes', () => {
  it('every pane whose tag is the old one gets the new one, and their ids come back', () => {
    const tmux = fakeTmux({ panes: `%1|${OLD}\n%2|${OTHER}\n%3|${OLD}\n` })
    const steps = journal()
    expect(defaultTmux(tmux.run).retag(OLD, NEW, steps)).toEqual(['%1', '%3'])
    expect(tmux.calls).toEqual([['-V'], LISTING, setTag('%1', NEW), setTag('%3', NEW)])
    expect(steps.done).toEqual([{ did: 'pane', id: '%1' }, { did: 'pane', id: '%3' }])
  })

  it('each pane is in the journal before it is retagged', () => {
    const events: string[] = []
    const tmux = fakeTmux({ panes: `%1|${OLD}\n%3|${OLD}\n` })
    const run = (args: string[]) => {
      if (args[0] === 'set-option') events.push(`set ${args[3]}`)
      return tmux.run(args)
    }
    defaultTmux(run).retag(OLD, NEW, { add: (step) => events.push(`journal ${(step as { id: string }).id}`) })
    expect(events).toEqual(['journal %1', 'set %1', 'journal %3', 'set %3'])
  })

  it('a pane tagged by another daemon, or by nobody, is not touched', () => {
    const tmux = fakeTmux({ panes: `%1|${OTHER}\n%2|\n` })
    const steps = journal()
    expect(defaultTmux(tmux.run).retag(OLD, NEW, steps)).toEqual([])
    expect(tmux.calls).toEqual([['-V'], LISTING])
    expect(steps.done).toEqual([])
  })

  it('a tag set on the window is overridden on the pane', () => {
    // A pane with no tag of its own lists its window's, which a build before pane options set.
    const tmux = fakeTmux({ panes: `%4|${OLD}\n` })
    expect(defaultTmux(tmux.run).retag(OLD, NEW, journal())).toEqual(['%4'])
    expect(tmux.calls.filter((args) => args[0] === 'set-option')).toEqual([setTag('%4', NEW)])
  })

  it('a pane tmux cannot retag fails the step, and is in the journal', () => {
    const tmux = fakeTmux({ panes: `%1|${OLD}\n%2|${OLD}\n`, gone: ['%1'] })
    const steps = journal()
    expect(() => defaultTmux(tmux.run).retag(OLD, NEW, steps)).toThrow(/%1/)
    expect(steps.done).toEqual([{ did: 'pane', id: '%1' }])
  })

  it('before tmux 3.0 nothing is retagged: a pane has no options there', () => {
    const tmux = fakeTmux({ version: 'tmux 2.9', panes: `%1|${OLD}\n` })
    const steps = journal()
    expect(defaultTmux(tmux.run).retag(OLD, NEW, steps)).toEqual([])
    expect(tmux.calls).toEqual([['-V']])
    expect(steps.done).toEqual([])
  })

  it('tmux that is missing, or has no server, has no panes', () => {
    const missing = defaultTmux(fakeTmux({ installed: false }).run)
    expect(missing.version()).toBeNull()
    expect(missing.tags(true)).toEqual([])
    expect(missing.retag(OLD, NEW, journal())).toEqual([])
    const noServer = defaultTmux(fakeTmux({ server: false }).run)
    expect(noServer.version()).toBe('tmux 3.4')
    expect(noServer.tags(true)).toEqual([])
    expect(noServer.retag(OLD, NEW, journal())).toEqual([])
  })

  it('tags() reads every pane\'s tag, from its start command before tmux 3.0', () => {
    const now = fakeTmux({ panes: `${OLD}\n\n${OTHER}\n` })
    expect(defaultTmux(now.run).tags(true)).toEqual([OLD, OTHER])
    expect(now.calls).toEqual([['list-panes', '-a', '-F', paneOwnerFormat(true)]])
    const before = fakeTmux({ version: 'tmux 2.9', panes: `/usr/bin/env HARNESS_DAEMON=${OLD}\n${OTHER}\n` })
    expect(defaultTmux(before.run).tags(false)).toEqual([OLD, OTHER])
    expect(before.calls).toEqual([['list-panes', '-a', '-F', paneOwnerFormat(false)]])
  })

  it('tmux 2.9 has no pane options; 3.0, 3.4 and a version it cannot read have', () => {
    const versions = { 'tmux 2.9': false, 'tmux 2.8': false, 'tmux 3.0a': true, 'tmux 3.4': true, 'tmux next-3.6': true, 'tmux master': true }
    for (const [version, has] of Object.entries(versions)) {
      expect(hasPaneOptions(version), version).toBe(has)
      // As lib/tmuxVersion.ts reads it, which the move does not load.
      expect(hasPaneOptions(version), version).toBe(atLeast(parseTmuxVersion(version), TMUX_FEATURE_MIN.paneOptions))
    }
    expect(hasPaneOptions(null)).toBe(true)
  })

  it('tag() sets a list of panes back', () => {
    const tmux = fakeTmux({ gone: ['%2'] })
    defaultTmux(tmux.run).tag(['%1', '%2', '%3'], OLD)
    // A pane closed since has no tag to put back, and does not stop the others.
    expect(tmux.calls).toEqual([setTag('%1', OLD), setTag('%2', OLD), setTag('%3', OLD)])
  })

  it('each call has a five-second limit', () => {
    const tmux = defaultTmux()
    tmux.version()
    tmux.tags(true)
    tmux.retag(OLD, NEW, journal())
    tmux.tag(['%1'], OLD)
    expect(spawned.mock.calls.map(([command, args]) => [command, args[0]]))
      .toEqual([['tmux', '-V'], ['tmux', 'list-panes'], ['tmux', '-V'], ['tmux', 'list-panes'], ['tmux', 'set-option'], ['tmux', 'set-option']])
    for (const [, , options] of spawned.mock.calls) expect(options).toMatchObject({ timeout: 5_000 })
  })

  it('the calls go to the default server, never to the one the start was typed in', () => {
    vi.stubEnv('TMUX', '/tmp/tmux-501/work,123,0')
    vi.stubEnv('TMUX_PANE', '%9')
    vi.stubEnv('TMUX_TMPDIR', '/run/user/501')
    defaultTmux().version()
    const env = (spawned.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env
    expect(env).not.toHaveProperty('TMUX')
    expect(env).not.toHaveProperty('TMUX_PANE')
    expect(env.TMUX_TMPDIR).toBe('/run/user/501')
  })
})
