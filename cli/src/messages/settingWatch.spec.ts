import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SETTINGS_DEFAULTS, agentSettingsPath, saveAgentSettings } from '../lib/agentSettings.js'
import { POLL_MS, watchSettingFile } from './settingWatch.js'

/** The core's sync writing the copy, as it does: whole, renamed over the one before (lib/agentSettings.ts). */
const write = (root: string, agentMessages: boolean) =>
  saveAgentSettings(root, { accountId: 'acct', machineId: 'm1' }, { ...AGENT_SETTINGS_DEFAULTS, agentMessages })

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'setting-watch-')) })
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

/** Wait for [check], looking every 20 ms, up to [ms]. */
const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((settle) => setTimeout(settle, 20))
  }
}

/** A computer with no inotify watches left: the file can only be looked at by time. */
const noWatches = (): never => { throw Object.assign(new Error('ENOSPC: no inotify watches left'), { code: 'ENOSPC' }) }

/** A watch a test drives: its listener, its close, and its error. */
class FakeWatch extends EventEmitter {
  closed = false
  constructor(readonly listener: () => void) { super() }
  close(): void { this.closed = true }
}

describe('the watch on the setting\'s file while Agent Messages are off', () => {
  it('hears every write to the file, each a rename over the one it watched, until it is stopped', async () => {
    write(root, false)
    const changed = vi.fn()
    const stop = watchSettingFile(agentSettingsPath(root), changed)
    // Read once more as the watch takes hold, for a write it could not yet hear.
    await until(() => changed.mock.calls.length === 1)
    // As the core's sync writes it: whole, renamed into place.
    write(root, true)
    await until(() => changed.mock.calls.length >= 2)
    const heard = changed.mock.calls.length
    write(root, false)
    await until(() => changed.mock.calls.length > heard)
    stop()
    stop()
    const after = changed.mock.calls.length
    write(root, true)
    await new Promise((settle) => setTimeout(settle, 300))
    expect(changed).toHaveBeenCalledTimes(after)
  })

  it('watches nothing and polls nothing for a file that is not there: every switch is at its default', async () => {
    // Polling for the file would be the timer off must not cost; the daemon's write tells the service instead.
    const changed = vi.fn()
    const poll = vi.fn(() => () => {})
    const stop = watchSettingFile(agentSettingsPath(root), changed, { poll })
    write(root, true)
    await new Promise((settle) => setTimeout(settle, 300))
    expect(poll).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    stop()
  })

  it('looks at the file\'s time where it cannot be watched for another reason, and stops looking once stopped', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const changed = vi.fn()
    const path = agentSettingsPath(root)
    write(root, false)
    // Looked at by time, the real way: nothing written, nothing heard.
    const stop = watchSettingFile(path, changed, { watch: noWatches })
    vi.advanceTimersByTime(POLL_MS * 3)
    expect(changed).not.toHaveBeenCalled()
    // As the core's sync writes it: whole, renamed into place. Heard at the next look, not before.
    write(root, true)
    vi.advanceTimersByTime(POLL_MS - 1)
    expect(changed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(changed).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(POLL_MS * 3)
    expect(changed).toHaveBeenCalledOnce()
    stop()
    write(root, false)
    vi.advanceTimersByTime(POLL_MS * 3)
    expect(changed).toHaveBeenCalledOnce()
    const polls = vi.fn(() => () => {})
    const stopped = vi.fn()
    watchSettingFile(agentSettingsPath(root), changed, { watch: noWatches, poll: (_p, listener) => { polls(); listener(); return stopped } })()
    expect(polls).toHaveBeenCalledOnce()
    expect(stopped).toHaveBeenCalledOnce()
  })

  it('hears a write made the moment it starts looking by time: it starts from the file as it was, not as it is later', () => {
    // Node's own looking (fs.watchFile) takes its first look later, off the main thread; a write before it was taken
    // as where it started, and never heard. On a busy machine that was every time.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const changed = vi.fn()
    const stop = watchSettingFile(agentSettingsPath(root), changed, { watch: noWatches })
    writeFileSync(agentSettingsPath(root), '{"agentMessages":true}\n')
    vi.advanceTimersByTime(POLL_MS)
    expect(changed).toHaveBeenCalledOnce()
    stop()
  })

  it('keeps looking by time through a look that fails, and hears the file once it can be read again', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const changed = vi.fn()
    const folder = join(root, 'data')
    const path = agentSettingsPath(folder)
    mkdirSync(folder)
    write(folder, false)
    // The data folder closed to this user: every look fails (EACCES), and must not take the process down.
    chmodSync(folder, 0o000)
    let stop: () => void
    try {
      stop = watchSettingFile(path, changed, { watch: noWatches })
      vi.advanceTimersByTime(POLL_MS * 2)
    } finally {
      chmodSync(folder, 0o700)
    }
    expect(changed).not.toHaveBeenCalled()
    write(folder, true)
    vi.advanceTimersByTime(POLL_MS)
    expect(changed).toHaveBeenCalledOnce()
    stop()
  })

  it('re-arms before it says the file changed, and never hears a watch it replaced or stopped', async () => {
    const watches: FakeWatch[] = []
    const changed = vi.fn()
    const stop = watchSettingFile('/data/agent-settings.json', changed, {
      watch: (_path, listener) => { const w = new FakeWatch(listener); watches.push(w); return w },
      poll: () => () => {},
    })
    expect(watches).toHaveLength(1)
    // Its read for the next turn, once the watch holds.
    await new Promise((settle) => setImmediate(settle))
    expect(changed).toHaveBeenCalledOnce()
    changed.mockClear()
    changed.mockImplementation(() => { expect(watches).toHaveLength(2) })
    watches[0].listener()
    expect(watches[0].closed).toBe(true)
    expect(changed).toHaveBeenCalledOnce()
    // The replaced watch says something late: not heard.
    watches[0].listener()
    watches[0].emit('error', new Error('late'))
    expect(changed).toHaveBeenCalledOnce()
    stop()
    expect(watches[1].closed).toBe(true)
    watches[1].listener()
    watches[1].emit('error', new Error('after stop'))
    // Stopped before its next turn: its read for it is not made.
    await new Promise((settle) => setImmediate(settle))
    expect(changed).toHaveBeenCalledOnce()
  })

  it('falls back to looking by time when a watch fails later, and says the file may have changed', async () => {
    const watches: FakeWatch[] = []
    const changed = vi.fn()
    const stopPolling = vi.fn()
    const poll = vi.fn(() => stopPolling)
    const stop = watchSettingFile('/data/agent-settings.json', changed, {
      watch: (_path, listener) => { const w = new FakeWatch(listener); watches.push(w); return w },
      poll,
    })
    watches[0].emit('error', new Error('the folder went'))
    expect(watches[0].closed).toBe(true)
    expect(poll).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledOnce()
    // The failed watch's read for its next turn is not made: the polling has the file now.
    await new Promise((settle) => setImmediate(settle))
    expect(changed).toHaveBeenCalledOnce()
    stop()
    expect(stopPolling).toHaveBeenCalledOnce()
  })
})
