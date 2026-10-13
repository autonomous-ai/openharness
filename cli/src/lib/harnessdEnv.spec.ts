import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store is the process's: each test gets a fresh one, and never touches the runner's own process.env.
let harnessd: typeof import('./harnessdEnv.js')
beforeEach(async () => {
  vi.resetModules()
  harnessd = await import('./harnessdEnv.js')
})

/** What a master starts a core with, beside the person's own variables. */
const started = (): NodeJS.ProcessEnv => ({
  HOME: '/home/someone', PATH: '/usr/bin:/bin',
  HARNESSD_SERVICE_TOKEN: 'fixture-token', HARNESSD_SUPERVISED: '1', HARNESSD_SERVICES: 'search,viewers',
  HARNESSD_WATCHDOG_MS: '30000', HARNESSD_TEST_FAULTS: 'search.crash',
  // Named like one, but not harnessd's: only the prefix counts.
  HARNESS_PORT: '18473', MY_HARNESSD_NOTE: 'kept',
})

describe('harnessd\'s variables', () => {
  it('are the HARNESSD_* ones and no others', () => {
    expect(harnessd.isHarnessdVariable('HARNESSD_SERVICE_TOKEN')).toBe(true)
    expect(harnessd.isHarnessdVariable('HARNESSD_TEST_FAULTS')).toBe(true)
    expect(harnessd.isHarnessdVariable('HARNESS_PORT')).toBe(false)
    expect(harnessd.isHarnessdVariable('MY_HARNESSD_NOTE')).toBe(false)
    expect(harnessd.isHarnessdVariable('harnessd_service_token')).toBe(false)
  })

  it('leave the environment once held, and are still read through harnessdEnv()', () => {
    const env = started()
    harnessd.holdHarnessdEnv(env)
    expect(env).toEqual({ HOME: '/home/someone', PATH: '/usr/bin:/bin', HARNESS_PORT: '18473', MY_HARNESSD_NOTE: 'kept' })
    expect(harnessd.harnessdEnv(env)).toEqual(started())
  })

  it('are put back over what the environment has now, which changes on its own (a PATH tmux was found on)', () => {
    const env = started()
    harnessd.holdHarnessdEnv(env)
    env.PATH = '/opt/homebrew/bin:/usr/bin:/bin'
    const read = harnessd.harnessdEnv(env)
    expect(read.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(read.HARNESSD_SERVICE_TOKEN).toBe('fixture-token')
    // A copy: what a reader does with it changes neither.
    read.HARNESSD_SERVICE_TOKEN = 'changed'
    expect(harnessd.harnessdEnv(env).HARNESSD_SERVICE_TOKEN).toBe('fixture-token')
    expect(env.HARNESSD_SERVICE_TOKEN).toBeUndefined()
  })

  it('read as the environment itself before anything is held, as in a process that holds none', () => {
    expect(harnessd.harnessdEnv(started())).toEqual(started())
  })

  it('held twice keep what the first hold took', () => {
    const env = started()
    harnessd.holdHarnessdEnv(env)
    harnessd.holdHarnessdEnv(env)
    expect(harnessd.harnessdEnv(env).HARNESSD_SERVICES).toBe('search,viewers')
  })

  it('are held from process.env when no environment is named, and a child started after it has none of them', () => {
    const original = { ...process.env }
    process.env.HARNESSD_SERVICE_TOKEN = 'fixture-token'
    process.env.HARNESSD_SUPERVISED = '1'
    try {
      harnessd.holdHarnessdEnv()
      expect(process.env.HARNESSD_SERVICE_TOKEN).toBeUndefined()
      expect(harnessd.harnessdEnv().HARNESSD_SERVICE_TOKEN).toBe('fixture-token')
      // What a child process is given when it is given nothing: process.env, as it is now.
      const child = execFileSync(process.execPath, ['-e', 'process.stdout.write(Object.keys(process.env).filter((name) => name.startsWith("HARNESSD_")).join(","))'], { encoding: 'utf8' })
      expect(child).toBe('')
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name]
      Object.assign(process.env, original)
    }
  })
})
