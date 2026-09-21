// probeDsh on real processes: the id a live engine carries in HARNESS_DSH, read off its environment.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { clearProcessEnvCache } from '../lib/processEnv.js'
import { probeDsh } from './probe.js'

describe('probeDsh', () => {
  const children: ChildProcess[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
    clearProcessEnvCache()
  })

  const live = async (extra: Record<string, string>): Promise<ChildProcess> => {
    const env = { ...process.env, ...extra }
    if (!('HARNESS_DSH' in extra)) delete env.HARNESS_DSH
    // Node, not /bin/sleep: macOS will not show a platform binary's environment to anyone.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env, stdio: 'ignore' })
    children.push(child)
    await new Promise((resolve) => setTimeout(resolve, 200))
    return child
  }

  it('answers the id a harness process carries, and null for a plain engine', async () => {
    const harness = await live({ HARNESS_DSH: 'autonomous/typst' })
    expect(await probeDsh({ pid: harness.pid!, executable: 'node', startMarker: 'a' })).toBe('autonomous/typst')
    const plain = await live({ SOME_OTHER: '1' })
    expect(await probeDsh({ pid: plain.pid!, executable: 'node', startMarker: 'b' })).toBeNull()
    const spoofed = await live({ HARNESS_DSH: '../../etc' })
    expect(await probeDsh({ pid: spoofed.pid!, executable: 'node', startMarker: 'c' })).toBeNull()
  })

  it('answers undefined, never null, when the process cannot be read', async () => {
    const gone = await live({ HARNESS_DSH: 'autonomous/typst' })
    const pid = gone.pid!
    gone.kill('SIGKILL')
    await new Promise((resolve) => gone.once('exit', resolve))
    expect(await probeDsh({ pid, executable: 'node', startMarker: 'gone' })).toBeUndefined()
  })
})
