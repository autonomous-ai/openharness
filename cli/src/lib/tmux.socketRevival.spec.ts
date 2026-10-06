import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A tmux server whose socket was removed while it ran (e2e/tmuxsocket.e2e.ts): the server last read from
// is remembered, and asked to make its socket again with SIGUSR1, only while it is still a running tmux.
const tmux = vi.hoisted(() => ({ serverPid: '4242', comm: 'tmux', asked: [] as string[][] }))
vi.mock('child_process', async (real) => {
  const actual = await real<typeof import('child_process')>()
  return {
    ...actual,
    execFile: (file: string, args: string[], _options: unknown, done: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (file === 'tmux' || file === 'ps') {
        tmux.asked.push([file, ...args])
        const stdout = file === 'ps' ? `${tmux.comm}\n` : `${tmux.serverPid}\n`
        queueMicrotask(() => done(null, stdout, ''))
        return {}
      }
      return (actual.execFile as unknown as (...a: unknown[]) => unknown)(file, args, _options, done)
    },
  }
})

const { forgetTmuxServer, rememberTmuxServer, reviveRemovedTmuxSocket } = await import('./tmux.js')

describe('a tmux server whose socket was removed while it ran', () => {
  let running: Set<number>
  let signals: Array<[number, string | number | undefined]>
  beforeEach(() => {
    running = new Set([4242])
    signals = []
    tmux.serverPid = '4242'
    tmux.comm = 'tmux'
    tmux.asked = []
    forgetTmuxServer()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (!running.has(pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      if (signal !== 0) signals.push([pid, signal])
      return true
    }) as typeof process.kill)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('remembers the server an inventory came from, and asks tmux again only once that one is gone', async () => {
    await rememberTmuxServer()
    await rememberTmuxServer()
    expect(tmux.asked.filter(([file]) => file === 'tmux')).toHaveLength(1)
    running.delete(4242)
    running.add(5151)
    tmux.serverPid = '5151'
    await rememberTmuxServer()
    expect(tmux.asked.filter(([file]) => file === 'tmux')).toHaveLength(2)
    expect(await reviveRemovedTmuxSocket()).toBe(true)
    expect(signals).toEqual([[5151, 'SIGUSR1']])
  })

  it('asks the remembered server to make its socket again while it still runs as tmux', async () => {
    await rememberTmuxServer()
    expect(await reviveRemovedTmuxSocket()).toBe(true)
    expect(signals).toEqual([[4242, 'SIGUSR1']])
    expect(console.log).toHaveBeenCalledWith('[terminal] tmux\'s socket was removed while its server (pid 4242) still ran — asked it to make a new one')
  })

  it('knows a server by the name Linux gives it as well as by its executable, and never signals a client', async () => {
    // Linux reports the server as `tmux: server` (tmux sets it with prctl, compat/setproctitle.c); macOS
    // by its path. Matched on `tmux` alone, no socket was ever made again on Linux.
    await rememberTmuxServer()
    tmux.comm = 'tmux: server'
    expect(await reviveRemovedTmuxSocket()).toBe(true)
    tmux.comm = '/opt/homebrew/bin/tmux'
    expect(await reviveRemovedTmuxSocket()).toBe(true)
    tmux.comm = 'tmux: client'
    expect(await reviveRemovedTmuxSocket()).toBe(false)
    expect(signals).toEqual([[4242, 'SIGUSR1'], [4242, 'SIGUSR1']])
  })

  it('signals nothing with no server remembered, one that has exited, or a pid now running something else', async () => {
    expect(await reviveRemovedTmuxSocket()).toBe(false)
    await rememberTmuxServer()
    running.delete(4242)
    expect(await reviveRemovedTmuxSocket()).toBe(false)
    // The pid came back as another program: SIGUSR1 would end most of them.
    running.add(4242)
    tmux.comm = '/usr/bin/vim'
    expect(await reviveRemovedTmuxSocket()).toBe(false)
    expect(signals).toEqual([])
  })

  it('remembers nothing tmux did not name as a pid', async () => {
    tmux.serverPid = 'no server running on /tmp/tmux-501/default'
    await rememberTmuxServer()
    expect(await reviveRemovedTmuxSocket()).toBe(false)
    expect(signals).toEqual([])
  })
})
