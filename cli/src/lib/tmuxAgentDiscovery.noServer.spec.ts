import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * With no tmux server (a daemon at rest: no agent, nothing open), every discovery pass still started `tmux
 * list-panes` to hear "no server", every 5 s: a fifth of an idle core's CPU (#3880, measured 2026-11-10). tmux names
 * the socket it found missing; until that file is there (a server made it) the panes are none without asking, and
 * tmux is asked again at least every minute.
 */

const execFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile }))
vi.mock('./tmuxVersion.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tmuxVersion.js')>(),
  tmuxFeatures: async () => ({ paneOptions: true }),
}))

const { listTmuxPanes } = await import('./tmuxAgentDiscovery.js')
const { forgetTmuxServer, listPaneTitles, NO_SERVER_RECHECK_MS } = await import('./tmux.js')

let dir: string
let socket: string
let server: string | null
const listings = () => execFile.mock.calls.filter(([, args]) => args[0] === 'list-panes').length

beforeEach(() => {
  forgetTmuxServer()
  dir = mkdtempSync(join(tmpdir(), 'harness-no-tmux-'))
  socket = join(dir, 'default')
  server = null
  execFile.mockReset()
  execFile.mockImplementation((_command: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (server === null) {
      const stderr = `error connecting to ${socket} (No such file or directory)\n`
      done(Object.assign(new Error(`Command failed: tmux ${args.join(' ')}\n${stderr}`), { code: 1 }), '', stderr)
    } else done(null, args[0] === 'list-panes' ? (args.at(-1)!.includes('pane_title') ? '%1|claude\n' : server) : '', '')
    return { killed: false }
  })
})
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

describe('the tmux panes with no tmux server', () => {
  it('asks tmux once, then answers none until the socket it named is there', async () => {
    expect(await listTmuxPanes('owner')).toEqual({ ok: true, panes: [] })
    expect(await listTmuxPanes('owner')).toEqual({ ok: true, panes: [] })
    expect(listings()).toBe(1)

    // A server starts (this daemon's first agent, or the person's own tmux): its socket is there at once.
    server = '%1|42|harness-claude-1|/work|owner\n'
    writeFileSync(socket, '')
    expect(await listTmuxPanes('owner')).toMatchObject({ ok: true, panes: [{ tmuxPane: '%1', rootPid: 42 }] })
    expect(listings()).toBe(2)
  })

  it('asks tmux again after a minute, whatever the socket', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await listTmuxPanes('owner')
    vi.setSystemTime(Date.now() + NO_SERVER_RECHECK_MS - 1)
    await listTmuxPanes('owner')
    expect(listings()).toBe(1)
    vi.setSystemTime(Date.now() + 1)
    await listTmuxPanes('owner')
    expect(listings()).toBe(2)
  })

  it('holds off the pane titles the same way', async () => {
    expect(await listPaneTitles()).toEqual(new Map())
    expect(await listTmuxPanes('owner')).toEqual({ ok: true, panes: [] })
    expect(await listPaneTitles()).toEqual(new Map())
    expect(listings()).toBe(1)

    server = '%1|42|harness-claude-1|/work|owner\n'
    writeFileSync(socket, '')
    expect(await listPaneTitles()).toEqual(new Map([['%1', 'claude']]))
    expect(listings()).toBe(2)
  })
})
