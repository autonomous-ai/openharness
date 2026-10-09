import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { TmuxBackend } from './tmuxBackend.js'
import { heldPaneArgv } from '../core/agents/heldLaunches.js'
import { resetTmuxVersionCache } from './tmuxVersion.js'

// Every command, including bare calls from the backend, uses this fixture's captured private socket.
// Neither TMUX nor the default socket inherited from a coding session may take precedence.
describe.skipIf(!resolveBinaryOnPath('tmux'))('external adoption on a private tmux server', () => {
  let tmux: IsolatedTmux
  beforeAll(async () => {
    tmux = await isolatedTmux()
    vi.stubEnv('TMUX', undefined); vi.stubEnv('TMUX_PANE', undefined); vi.stubEnv('TMUX_TMPDIR', tmux.root)
    resetTmuxVersionCache()
  })
  afterAll(async () => { await tmux?.close(); vi.unstubAllEnvs(); resetTmuxVersionCache() })
  const backend = new TmuxBackend(undefined, () => 'adoption-test', () => {})
  const waiting = async (token: string) => {
    const pane = await backend.create({ label: `harness-fixture-${randomUUID()}`, command: heldPaneArgv('Waiting for fixture.', token) })
    if (pane.state !== 'succeeded') throw new Error(pane.reason)
    return pane.runtime
  }

  it('atomically requires the waiting token and preserves literal argv, environment and cwd in its dispatch', async () => {
    const token = randomUUID(), pane = await waiting(token), onDispatch = vi.fn()
    const folder = join(tmux.root, "work '; dollars$"); mkdirSync(folder)
    const output = join(tmux.root, 'literal-result'), value = "an apostrophe ' and ; $literal"
    const request = { command: ['/bin/sh', '-c', 'printf "%s\\n" "$SAMPLE" "$PWD" "$1" > "$2"; exec sleep 30', 'fixture', value, output],
      cwd: folder, env: { SAMPLE: value }, expectedHeldToken: randomUUID(), current: () => true, onDispatch }
    expect(await backend.isHeld(pane, token)).toBe(true)
    expect(await backend.respawn(pane, request)).toMatchObject({ dispatch: 'not_started' })
    expect(existsSync(output)).toBe(false)
    expect(await backend.isHeld(pane, token)).toBe(true)
    expect(await backend.respawn(pane, { ...request, expectedHeldToken: token })).toMatchObject({ state: 'succeeded' })
    await vi.waitFor(() => expect(existsSync(output)).toBe(true))
    expect(readFileSync(output, 'utf8').split('\n')).toEqual([value, folder, value, ''])
    expect(await backend.isHeld(pane, token)).toBe(false)
    expect(await backend.killHeld(pane, token, () => true)).toMatchObject({ dispatch: 'not_started' })
    await backend.kill(pane)
  })

  it('cannot cancel a replacement waiting shell, and an uncommitted dispatch never replaces its pane', async () => {
    const token = randomUUID(), next = randomUUID(), pane = await waiting(token)
    await expect(backend.respawn(pane, { command: ['/bin/false'], expectedHeldToken: token, onDispatch: () => { throw new Error('disk full') } })).rejects.toThrow('disk full')
    expect(await backend.isHeld(pane, token)).toBe(true)
    expect(await backend.respawn(pane, { command: ['/bin/false'], expectedHeldToken: token, current: () => false })).toMatchObject({ dispatch: 'not_started' })
    expect(await backend.killHeld(pane, token, () => false)).toMatchObject({ dispatch: 'not_started' })
    expect(await backend.respawn(pane, { command: heldPaneArgv('Replacement intent.', next), expectedHeldToken: token })).toMatchObject({ state: 'succeeded' })
    expect(await backend.killHeld(pane, token, () => true)).toMatchObject({ dispatch: 'not_started' })
    expect(await backend.isHeld(pane, next)).toBe(true)
    expect(await backend.killHeld(pane, next, () => true)).toMatchObject({ state: 'succeeded' })
    expect(await backend.isHeld(pane, next)).toBe(false)
    expect(await backend.killHeld(pane, next, () => true)).toMatchObject({ state: 'succeeded' })
  })
})
