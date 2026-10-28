import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encryptDownFrame, encryptRpcResult } from '../lib/e2ee/applicationFrames.js'
import { fakeCore } from '../testing/fakeCore.js'
import {
  activeSsid, CHECK_NOW, CMDLINE, deviceCodeOf, execBounded, GH, githubDeviceSignIn, githubLoginOf, joinRequest, LIVE_UPDATE, MAX_OUTPUT, nmcliFields, OS_DEVICE_REQUESTS, SETUP, SETUP_RESULT, spawnDetached,
  startOsDevice, UPDATE_BUSY_MS, updateOf, wifiNetworks, type OsDeviceDeps,
} from './osDevice.js'

// Nothing real is ever run: the defaults' child_process is this fake.
const child = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', () => child)

const OWNER = { local: false, owner: true }
const STATUS = JSON.stringify({
  runtime: '/var/lib/harness-os/builds/aaa', versions: { hn: '1.2.3', cli: '0.9.1' }, ready: '/var/lib/harness-os/builds/bbb',
  restart_required: false, system: { available: false, checked_at: 1 }, check: { errors: [] },
})

function service(over: OsDeviceDeps = {}) {
  const exec = vi.fn(async (file: string, args: readonly string[]) => {
    if (file === '/usr/bin/python3') return args[0] === SETUP ? 'Harness-BD19\n' : STATUS
    if (args.includes('ACTIVE,SSID')) return 'no:Other\nyes:Home\\: 5G\n'
    return 'Home\\: 5G:70:WPA2:*\nCafe:80:--:\n'
  })
  const spawnDetached = vi.fn()
  let clock = 1_000
  const readFile = async (path: string) => path === CMDLINE ? 'BOOT_IMAGE=/vmlinuz rd.luks.name=abc=cryptroot quiet\n' : '{"ok":true,"ssid":"Cafe"}'
  const deps: OsDeviceDeps = { env: {}, exists: () => true, exec, spawnDetached, now: () => clock, readFile, ...over }
  const ask = startOsDevice(fakeCore(), deps).os_device!
  return { ask: (payload: Record<string, unknown>, asker = OWNER) => ask(payload, asker), exec, spawnDetached, tick: (ms: number) => { clock += ms } }
}

describe('the Harness OS computer, managed from the phone', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); child.execFile.mockReset(); child.spawn.mockReset() })

  it('answers the one request it declares, and only to the owner', async () => {
    expect(Object.keys(startOsDevice(fakeCore(), { env: {} }))).toEqual([...OS_DEVICE_REQUESTS])
    const { ask, exec } = service()
    expect(await ask({ action: 'status' }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    expect(await ask({ action: 'reboot' })).toEqual({ error: 'BAD_REQUEST' })
    expect(await ask({})).toEqual({ error: 'BAD_REQUEST' })
    expect(exec).not.toHaveBeenCalled()
  })

  it('is always sealed over the relay: a Wi-Fi join carries the password', () => {
    expect(encryptDownFrame('os_device')).toBe(true)
    expect(encryptRpcResult('os_device_result')).toBe(true)
  })

  it('says a computer is not on Harness OS, and does nothing else there', async () => {
    const { ask, exec, spawnDetached } = service({ exists: () => false })
    expect(await ask({ action: 'status' })).toEqual({ harnessOs: false })
    for (const action of ['update', 'wifi_scan', 'wifi_join', 'wifi_result']) expect(await ask({ action, ssid: 'x' })).toEqual({ error: 'UNSUPPORTED_OS' })
    expect(exec).not.toHaveBeenCalled()
    expect(spawnDetached).not.toHaveBeenCalled()
  })

  it('knows Harness OS by its update tool or HARNESS_OS=1', async () => {
    const exists = vi.fn(() => false)
    expect(await service({ exists, env: { HARNESS_OS: '1' } }).ask({ action: 'status' })).toMatchObject({ harnessOs: true })
    expect(exists).not.toHaveBeenCalled()
    exists.mockReturnValue(true)
    expect(await service({ exists, env: { HARNESS_OS: '0' } }).ask({ action: 'status' })).toMatchObject({ harnessOs: true })
    expect(exists).toHaveBeenCalledWith(LIVE_UPDATE)
  })

  it('reads the update, the network the computer is on, its hotspot and whether it is encrypted, bounded', async () => {
    const { ask, exec } = service()
    expect(await ask({ action: 'status' })).toEqual({
      harnessOs: true,
      update: {
        available: true, runtime: '0.9.1', version: 'bbb',
        parts: {
          os: { running: null, available: false, next: null },
          hn: { running: '1.2.3', available: true, next: null },
          cli: { running: '0.9.1', available: true, next: null },
        },
      },
      wifi: { ssid: 'Home: 5G' }, hotspot: 'Harness-BD19', encrypted: true, features: ['sign_out', 'password', 'ssh', 'github', 'check_update'],
    })
    expect(exec).toHaveBeenCalledWith('/usr/bin/python3', [LIVE_UPDATE, 'status'], { timeout: 15_000 })
    expect(exec).toHaveBeenCalledWith('/usr/bin/python3', [SETUP, 'name'], { timeout: 10_000 })
    expect(exec).toHaveBeenCalledWith('nmcli', ['-t', '-e', 'yes', '-f', 'ACTIVE,SSID', 'device', 'wifi'], { timeout: 10_000 })
    const plain = service({ readFile: async (path: string) => path === CMDLINE ? 'BOOT_IMAGE=/vmlinuz root=UUID=x quiet\n' : '{}' })
    expect(await plain.ask({ action: 'status' })).toMatchObject({ encrypted: false })
  })

  it('still answers on Harness OS when its update tool or nmcli fails', async () => {
    const failing = (reason: unknown) => service({ exec: vi.fn(async () => { throw reason }) }).ask({ action: 'status' })
    expect(await failing(new Error('Command failed: python3\nTraceback ...'))).toEqual({ harnessOs: true, update: { available: false, error: 'Command failed: python3' }, wifi: { ssid: null }, hotspot: null, encrypted: true, features: ['sign_out', 'password', 'ssh', 'github', 'check_update'] })
    expect(await failing('killed')).toEqual({ harnessOs: true, update: { available: false, error: 'killed' }, wifi: { ssid: null }, hotspot: null, encrypted: true, features: ['sign_out', 'password', 'ssh', 'github', 'check_update'] })
    const notJson = service({ exec: vi.fn(async () => 'not json') })
    expect(await notJson.ask({ action: 'status' })).toMatchObject({ update: { available: false, error: expect.stringContaining('JSON') } })
    const notObject = service({ exec: vi.fn(async () => '[1]') })
    expect(await notObject.ask({ action: 'status' })).toMatchObject({ update: { available: false, error: 'live_update.py status did not answer an object' } })
  })

  it('still reports status when the boot command line is unreadable and no hotspot is named', async () => {
    const { ask } = service({
      readFile: async () => { throw new Error('boot command line unavailable') },
      exec: async (file, args) => args[0] === SETUP ? '  \n' : file === '/usr/bin/python3' ? STATUS : '',
    })
    expect(await ask({ action: 'status' })).toMatchObject({ harnessOs: true, encrypted: false, hotspot: null, update: { available: true } })
  })

  it('reads an update as available from the system channel or a runtime build ready', () => {
    expect(updateOf({ runtime: '/b/aaa', ready: null, system: { available: true, version: '2026.10.14' }, versions: {} }))
      .toMatchObject({ available: true, runtime: 'aaa', version: '2026.10.14' })
    expect(updateOf({ runtime: '/b/aaa', ready: '/b/aaa', system: { supported: false, available: false }, restart_required: true }))
      .toMatchObject({ available: false, runtime: 'aaa', restartRequired: true })
    expect(updateOf({ runtime: '/b/aaa', ready: '/b/ccc', system: { available: true } })).toMatchObject({ available: true, runtime: 'aaa', version: 'ccc' })
    expect(updateOf({ system: [], versions: [] })).toMatchObject({ available: false, runtime: null })
  })

  it('names each part, what runs and what waits: the OS alone, hn and the CLI as one runtime', () => {
    expect(updateOf({
      runtime: '/b/aaa', ready: '/b/ccc', os: '0.1.7.r1-1', versions: { hn: '0.1.38', cli: '0.4.29' },
      ready_versions: { hn: '0.1.39', cli: '0.4.30' }, system: { available: true, version: '0.1.8.r2-1' },
    }).parts).toEqual({
      os: { running: '0.1.7.r1-1', available: true, next: '0.1.8.r2-1' },
      hn: { running: '0.1.38', available: true, next: '0.1.39' },
      cli: { running: '0.4.29', available: true, next: '0.4.30' },
    })
    expect(updateOf({ runtime: '/b/aaa', ready: '/b/aaa', os: '0.1.7.r1-1', versions: { hn: '0.1.38', cli: '0.4.29' }, system: {} }).parts).toEqual({
      os: { running: '0.1.7.r1-1', available: false, next: null },
      hn: { running: '0.1.38', available: false, next: null },
      cli: { running: '0.4.29', available: false, next: null },
    })
  })

  it('starts a phone\'s update with the restart it agreed to', async () => {
    const { ask, spawnDetached } = service()
    expect(await ask({ action: 'update', reboot: true })).toEqual({ started: true })
    expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/harness', ['update', '--reboot'])
  })

  it('signs the computer out for another account, detached', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ask, spawnDetached } = service()
    expect(await ask({ action: 'sign_out' })).toEqual({ started: true })
    expect(spawnDetached).toHaveBeenCalledWith('sudo', ['-n', '/usr/bin/python3', SETUP, 'sign-out'])
  })

  it('changes the password with both only on the helper\'s stdin', async () => {
    const exec = vi.fn(async () => '{"ok": true, "disk": true}')
    const { ask } = service({ exec })
    expect(await ask({ action: 'password', current: '1234', next: 'abcd' })).toEqual({ ok: true, disk: true })
    expect(exec).toHaveBeenCalledWith('sudo', ['-n', '/usr/bin/python3', SETUP, 'password'],
      { timeout: 90_000, input: JSON.stringify({ current: '1234', new: 'abcd' }) })
    expect(await ask({ action: 'password', current: '1234' })).toMatchObject({ error: 'BAD_REQUEST' })
    exec.mockResolvedValueOnce('{"error": "WRONG_PASSWORD", "message": "That is not the computer\'s password."}')
    expect(await ask({ action: 'password', current: 'x', next: 'abcd' })).toMatchObject({ error: 'WRONG_PASSWORD' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    exec.mockResolvedValueOnce('["ok"]')
    expect(await ask({ action: 'password', current: '1234', next: 'abcd' }))
      .toEqual({ error: 'FAILED', message: 'setup.py password did not answer an object' })
  })

  it('turns SSH on or off, or says how it is', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const answer = { enabled: true, active: true, user: 'me', addresses: [{ interface: 'wlo1', address: '172.168.21.13' }] }
    const exec = vi.fn(async () => JSON.stringify(answer))
    const { ask } = service({ exec })
    expect(await ask({ action: 'ssh', state: 'on' })).toEqual(answer)
    expect(exec).toHaveBeenLastCalledWith('sudo', ['-n', '/usr/bin/python3', SETUP, 'ssh', 'on'], { timeout: 30_000 })
    await ask({ action: 'ssh', state: 'rm -rf' })
    expect(exec).toHaveBeenLastCalledWith('sudo', ['-n', '/usr/bin/python3', SETUP, 'ssh', 'status'], { timeout: 30_000 })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    exec.mockResolvedValueOnce('null')
    expect(await ask({ action: 'ssh', state: 'status' })).toEqual({ error: 'FAILED', message: 'setup.py ssh did not answer an object' })
  })

  it('starts the update detached, once in ten minutes', async () => {
    const { ask, spawnDetached, tick } = service()
    expect(await ask({ action: 'update' })).toEqual({ started: true })
    expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/harness', ['update'])
    tick(UPDATE_BUSY_MS - 1)
    expect(await ask({ action: 'update' })).toEqual({ error: 'BUSY' })
    tick(1)
    expect(await ask({ action: 'update' })).toEqual({ started: true })
    expect(spawnDetached).toHaveBeenCalledTimes(2)
  })

  it('does not count an update that could not start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const spawnDetached = vi.fn((): void => { throw new Error('spawn EAGAIN') })
    const { ask } = service({ spawnDetached })
    expect(await ask({ action: 'update' })).toEqual({ error: 'FAILED', message: 'spawn EAGAIN' })
    spawnDetached.mockImplementation(() => {})
    expect(await ask({ action: 'update' })).toEqual({ started: true })
  })

  describe('the test tools, turned on and off from the phone', () => {
    function tools(available = true) {
      const state = { on: false }
      const testTools = {
        available: () => available,
        on: () => state.on,
        set: vi.fn((on: boolean) => { state.on = on; return { on } }),
      }
      return { ...service({ testTools }), testTools }
    }

    it('names them among its features only on a computer that carries them', async () => {
      expect(await tools().ask({ action: 'status' })).toMatchObject({ features: expect.arrayContaining(['test_tools']) })
      expect((await tools(false).ask({ action: 'status' }) as { features: string[] }).features).not.toContain('test_tools')
    })

    it('says how they are, and turns them on and off', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { ask, testTools } = tools()
      expect(await ask({ action: 'test_tools' })).toEqual({ on: false })
      expect(await ask({ action: 'test_tools', state: 'on' })).toEqual({ on: true })
      expect(await ask({ action: 'test_tools' })).toEqual({ on: true })
      expect(await ask({ action: 'test_tools', state: 'off' })).toEqual({ on: false })
      expect(testTools.set.mock.calls).toEqual([[true], [false]])
    })

    it('answers why it could not, and nothing on a computer without them', async () => {
      const { ask, testTools } = tools()
      testTools.set.mockReturnValueOnce({ error: 'Fix or remove it first: not JSON' } as never)
      expect(await ask({ action: 'test_tools', state: 'on' })).toEqual({ error: 'FAILED', message: 'Fix or remove it first: not JSON' })
      expect(await tools(false).ask({ action: 'test_tools', state: 'on' })).toEqual({ error: 'UNSUPPORTED_OS' })
      expect(await tools().ask({ action: 'test_tools', state: 'on' }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    })
  })

  describe('checking for updates now, from the phone', () => {
    /** A computer whose check is held until [done] settles it. */
    function holding() {
      let settle!: (error?: Error) => void
      const { ask, exec } = service()
      const base = exec.getMockImplementation()!
      exec.mockImplementation(async (file: string, args: readonly string[]) => {
        if (args[0] !== '-c') return base(file, args)
        await new Promise<void>((resolve, reject) => { settle = (error) => error ? reject(error) : resolve() })
        return ''
      })
      const done = async (error?: Error) => { settle(error); await new Promise((resolve) => setImmediate(resolve)) }
      return { ask, exec, done }
    }

    it('runs the timer\'s check with the OS release asked now, bounded, and says so until it is done', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { ask, exec, done } = holding()
      expect(await ask({ action: 'check_update' })).toEqual({ started: true })
      expect(exec).toHaveBeenCalledWith('/usr/bin/python3', ['-c', CHECK_NOW], { timeout: 360_000 })
      expect(CHECK_NOW).toContain('live_update.check(force_system=True)')
      expect(await ask({ action: 'status' })).toMatchObject({ update: { checking: true } })
      await done()
      const status = await ask({ action: 'status' }) as { update: Record<string, unknown> }
      expect(status.update.checking).toBeUndefined()
      expect(status.update.checkError).toBeUndefined()
    })

    it('runs one check at a time', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { ask, exec, done } = holding()
      await ask({ action: 'check_update' })
      expect(await ask({ action: 'check_update' })).toEqual({ started: true })
      expect(exec.mock.calls.filter(([, args]) => args[0] === '-c')).toHaveLength(1)
      await done()
    })

    it('says a check that failed in words, until the next one', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { ask, done } = holding()
      await ask({ action: 'check_update' })
      await done(new Error('Command failed: python3 -c\nValueError: Could not check for updates.'))
      expect(await ask({ action: 'status' })).toMatchObject({
        update: { checkError: 'Could not check for updates. Check its internet, then try again.' },
      })
      await ask({ action: 'check_update' })
      expect(await ask({ action: 'status' })).toMatchObject({ update: { checking: true } })
      await done()
    })
  })

  it('lists the networks it sees, the one in use first', async () => {
    const { ask, exec } = service()
    expect(await ask({ action: 'wifi_scan' })).toEqual({ networks: [{ ssid: 'Home: 5G', signal: 70, security: 'WPA2', active: true }, { ssid: 'Cafe', signal: 80, security: '', active: false }] })
    expect(exec).toHaveBeenCalledWith('nmcli', ['-t', '-e', 'yes', '-f', 'SSID,SIGNAL,SECURITY,IN-USE', 'device', 'wifi', 'list', '--rescan', 'auto'], { timeout: 20_000 })
  })

  it('answers a scan that failed as a failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ask } = service({ exec: vi.fn(async () => { throw new Error('nmcli: not found') }) })
    expect(await ask({ action: 'wifi_scan' })).toEqual({ error: 'FAILED', message: 'Could not list Wi-Fi networks: nmcli: not found' })
    expect(error).toHaveBeenCalledWith('[os-device] wifi_scan failed:', 'Could not list Wi-Fi networks: nmcli: not found')
  })

  it('joins another network detached, the password on stdin alone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ask, spawnDetached } = service()
    expect(await ask({ action: 'wifi_join', ssid: 'Cafe', password: 'secret-pass' })).toEqual({ started: true })
    expect(spawnDetached).toHaveBeenCalledWith('sudo', ['-n', '/usr/bin/python3', SETUP, 'join'], '{"ssid":"Cafe","password":"secret-pass"}')
    expect(await ask({ action: 'wifi_join', ssid: 'Open' })).toEqual({ started: true })
    expect(spawnDetached).toHaveBeenLastCalledWith('sudo', ['-n', '/usr/bin/python3', SETUP, 'join'], '{"ssid":"Open","password":""}')
    expect(await ask({ action: 'wifi_join', ssid: '', password: 'secret-pass' })).toEqual({ error: 'BAD_REQUEST', message: 'Choose a Wi-Fi network.' })
    spawnDetached.mockImplementation(() => { throw new Error('spawn sudo ENOENT') })
    expect(await ask({ action: 'wifi_join', ssid: 'Cafe', password: 'secret-pass' })).toEqual({ error: 'FAILED', message: 'spawn sudo ENOENT' })
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-pass')
  })

  it('checks a join request before anything runs', () => {
    expect(joinRequest({ ssid: 7 })).toEqual({ message: 'Choose a Wi-Fi network.' })
    expect(joinRequest({ ssid: 'é'.repeat(16) })).toEqual({ ssid: 'é'.repeat(16), password: '' })
    expect(joinRequest({ ssid: 'é'.repeat(17) })).toEqual({ message: 'That network name is too long.' })
    expect(joinRequest({ ssid: 'a', password: null })).toEqual({ ssid: 'a', password: '' })
    expect(joinRequest({ ssid: 'a', password: '' })).toEqual({ ssid: 'a', password: '' })
    expect(joinRequest({ ssid: 'a', password: 12345678 })).toEqual({ message: 'The password must be text.' })
    expect(joinRequest({ ssid: 'a', password: 'short' })).toEqual({ message: 'A Wi-Fi password has 8 to 63 characters.' })
    expect(joinRequest({ ssid: 'a', password: 'x'.repeat(64) })).toEqual({ message: 'A Wi-Fi password has 8 to 63 characters.' })
    expect(joinRequest({ ssid: 'a', password: 'x'.repeat(63) })).toEqual({ ssid: 'a', password: 'x'.repeat(63) })
    expect(joinRequest({ ssid: 'a', password: 'line\nbreak' })).toEqual({ message: 'A Wi-Fi password cannot contain a line break.' })
    expect(joinRequest({ ssid: 'a', password: 'line\rbreak' })).toEqual({ message: 'A Wi-Fi password cannot contain a line break.' })
  })

  it('reads what became of the last join', async () => {
    const readFile = vi.fn(async () => '{"ok":true,"ssid":"Cafe"}')
    expect(await service({ readFile }).ask({ action: 'wifi_result' })).toEqual({ result: { ok: true, ssid: 'Cafe' } })
    expect(readFile).toHaveBeenCalledWith(SETUP_RESULT)
    expect(await service({ readFile: async () => '"done"' }).ask({ action: 'wifi_result' })).toEqual({ result: null })
    expect(await service({ readFile: async () => { throw new Error('ENOENT') } }).ask({ action: 'wifi_result' })).toEqual({ result: null })
  })

  it('reads nmcli\'s terse rows, escapes and all', () => {
    expect(nmcliFields('a\\:b:c\\\\d:')).toEqual(['a:b', 'c\\d', ''])
    expect(nmcliFields('trailing\\')).toEqual(['trailing\\'])
    expect(activeSsid('no:A\r\nyes:\nyes:B\n')).toBe('B')
    expect(activeSsid('')).toBeNull()
    expect(wifiNetworks([':90:WPA2:', 'A:40:WPA2:', 'A:60:WPA2:', 'B:x', 'A:50:WPA2:*', 'C:60:WPA1 WPA2: ', 'B:60', 'D'].join('\n'))).toEqual([
      { ssid: 'A', signal: 60, security: 'WPA2', active: true },
      { ssid: 'B', signal: 60, security: '', active: false },
      { ssid: 'C', signal: 60, security: 'WPA1 WPA2', active: false },
      { ssid: 'D', signal: 0, security: '', active: false },
    ])
  })

  describe('GitHub, for the agents to clone, push and open pull requests with', () => {
    const SIGNED_IN = JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'octo' }] } })
    const SIGNED_OUT = JSON.stringify({ hosts: {} })

    /** A `gh auth login` that shows [code] and ends when the test says. */
    function signIn(code = { code: 'AB12-CD34', url: 'https://github.com/login/device' }) {
      let end!: (error?: Error) => void
      const done = new Promise<void>((resolve, reject) => { end = (error) => error ? reject(error) : resolve() })
      done.catch(() => {})
      const run = { code: Promise.resolve(code), done, stop: vi.fn() }
      return { run, end }
    }

    function github(over: OsDeviceDeps = {}) {
      let account = SIGNED_OUT
      const exec = vi.fn(async (_file: string, args: readonly string[]) => {
        if (args[1] === 'logout') account = SIGNED_OUT
        return args[1] === 'status' ? account : ''
      })
      const login = signIn()
      const githubSignIn = vi.fn(() => login.run)
      const { ask } = service({ exec, githubSignIn, ...over })
      return { ask, exec, githubSignIn, login, signInAs: (name: string) => { account = SIGNED_IN.replace('octo', name) } }
    }

    it('says which account it uses, or none', async () => {
      const { ask, signInAs } = github()
      expect(await ask({ action: 'github' })).toEqual({ login: null })
      signInAs('octo')
      expect(await ask({ action: 'github', state: 'status' })).toEqual({ login: 'octo' })
    })

    it('reads an account whose token stopped working, or one not active, as signed out', () => {
      expect(githubLoginOf(SIGNED_IN)).toBe('octo')
      expect(githubLoginOf(SIGNED_IN.replace('success', 'error'))).toBeNull()
      expect(githubLoginOf(SIGNED_IN.replace('"active":true', '"active":false'))).toBeNull()
      expect(githubLoginOf('{}')).toBeNull()
    })

    it('signs in with a code to enter on another device, then sets git up to use the account', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { ask, exec, githubSignIn, login, signInAs } = github()
      const waiting = { login: null, signingIn: { code: 'AB12-CD34', url: 'https://github.com/login/device' } }
      expect(await ask({ action: 'github', state: 'sign_in' })).toEqual(waiting)
      // Asked again, the same code: one sign-in at a time.
      expect(await ask({ action: 'github', state: 'sign_in' })).toEqual(waiting)
      expect(await ask({ action: 'github' })).toEqual(waiting)
      expect(githubSignIn).toHaveBeenCalledTimes(1)
      signInAs('octo')
      login.end()
      await vi.waitFor(() => expect(exec).toHaveBeenCalledWith(GH, ['auth', 'setup-git', '--hostname', 'github.com'], { timeout: 15_000 }))
      expect(await ask({ action: 'github' })).toEqual({ login: 'octo' })
    })

    it('starts one sign-in for two asks at once, while its code is on its way', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      let show!: (code: { code: string; url: string }) => void
      const run = { code: new Promise<{ code: string; url: string }>((resolve) => { show = resolve }), done: new Promise<void>(() => {}), stop: vi.fn() }
      const githubSignIn = vi.fn(() => run)
      const { ask } = github({ githubSignIn })
      const first = ask({ action: 'github', state: 'sign_in' })
      const second = ask({ action: 'github', state: 'sign_in' })
      show({ code: 'AB12-CD34', url: 'https://github.com/login/device' })
      const waiting = { login: null, signingIn: { code: 'AB12-CD34', url: 'https://github.com/login/device' } }
      expect(await first).toEqual(waiting)
      expect(await second).toEqual(waiting)
      expect(githubSignIn).toHaveBeenCalledTimes(1)
    })

    it('sets git up once the code was entered', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { ask, exec, login, signInAs } = github()
      await ask({ action: 'github', state: 'sign_in' })
      signInAs('octo')
      login.end()
      await vi.waitFor(() => expect(exec).toHaveBeenCalledWith(GH, ['auth', 'setup-git', '--hostname', 'github.com'], { timeout: 15_000 }))
      expect(await ask({ action: 'github' })).toEqual({ login: 'octo' })
    })

    it('says why a sign-in ended without signing in, until the next one', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { ask, login } = github()
      await ask({ action: 'github', state: 'sign_in' })
      login.end(new Error('error: access denied'))
      await vi.waitFor(async () => expect(await ask({ action: 'github' })).toEqual({ login: null, signInError: 'error: access denied' }))
    })

    it('gives up on a sign-in that shows no code', async () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const stop = vi.fn()
      const { ask } = github({ githubSignIn: () => ({ code: new Promise(() => {}), done: new Promise(() => {}), stop }) })
      const answer = ask({ action: 'github', state: 'sign_in' })
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await answer).toEqual({ error: 'FAILED', message: 'gh auth login did not show a code' })
      expect(stop).toHaveBeenCalled()
      vi.useRealTimers()
    })

    it('signs out of the account it uses, and stops a sign-in waiting', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { ask, exec, login, signInAs } = github()
      await ask({ action: 'github', state: 'sign_in' })
      expect(await ask({ action: 'github', state: 'sign_out' })).toEqual({ login: null })
      expect(login.run.stop).toHaveBeenCalled()
      signInAs('octo')
      expect(await ask({ action: 'github', state: 'sign_out' })).toEqual({ login: null })
      expect(exec).toHaveBeenCalledWith(GH, ['auth', 'logout', '--hostname', 'github.com', '--user', 'octo'], { timeout: 15_000 })
    })

    /** A computer whose gh is gone, and the setup's install-gh answering [answer] (and putting gh back on `installed`). */
    function withoutGh(answer: () => Promise<string>) {
      let there = false
      let installed!: () => void
      const done = new Promise<void>((resolve) => { installed = resolve })
      const base = github()
      const exec = vi.fn(async (file: string, args: readonly string[], _options?: { timeout: number }) => {
        if (file === 'sudo') {
          try {
            const out = await answer()
            there = out.includes('"installed": true')
            return out
          } finally { installed() }
        }
        return base.exec(file, args)
      })
      const githubSignIn = vi.fn(() => base.login.run)
      const { ask } = service({ exec, githubSignIn, exists: (path) => path !== GH || there })
      return { ask, exec, githubSignIn, done, signInAs: base.signInAs }
    }

    it('puts a GitHub CLI that is gone back from the OS, then signs in, answering at once', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      let finish!: (out: string) => void
      const { ask, exec, githubSignIn, done } = withoutGh(() => new Promise((resolve) => { finish = resolve }))
      expect(await ask({ action: 'github' })).toEqual({ login: null, missing: true })
      expect(await ask({ action: 'github', state: 'sign_in' })).toEqual({ login: null, installing: true })
      // Asked again while it installs: the same install.
      expect(await ask({ action: 'github', state: 'sign_in' })).toEqual({ login: null, installing: true })
      expect(exec).toHaveBeenCalledWith('sudo', ['-n', '/usr/bin/python3', SETUP, 'install-gh'], { timeout: 300_000 })
      expect(exec.mock.calls.filter(([file]) => file === 'sudo')).toHaveLength(1)
      finish('{"installed": true}')
      await done
      await vi.waitFor(async () => expect(await ask({ action: 'github' }))
        .toEqual({ login: null, signingIn: { code: 'AB12-CD34', url: 'https://github.com/login/device' } }))
      expect(githubSignIn).toHaveBeenCalledTimes(1)
    })

    it('puts the GitHub CLI back without signing in again where its sign-in stayed', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { ask, githubSignIn, done, signInAs } = withoutGh(async () => '{"installed": true}')
      signInAs('octo')
      await ask({ action: 'github', state: 'sign_in' })
      await done
      await vi.waitFor(async () => expect(await ask({ action: 'github' })).toEqual({ login: 'octo' }))
      expect(githubSignIn).not.toHaveBeenCalled()
    })

    it('says why the GitHub CLI could not be put back', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { ask, githubSignIn, done } = withoutGh(async () => '{"installed": false, "message": "The GitHub CLI could not be installed: error: failed retrieving file"}')
      await ask({ action: 'github', state: 'sign_in' })
      await done
      await vi.waitFor(async () => expect(await ask({ action: 'github' }))
        .toEqual({ login: null, missing: true, signInError: 'The GitHub CLI could not be installed: error: failed retrieving file' }))
      expect(githubSignIn).not.toHaveBeenCalled()
    })

    it('asks for an update on an OS from before install-gh, whose sudo refuses it', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { ask, done } = withoutGh(async () => { throw new Error('sudo: a password is required') })
      await ask({ action: 'github', state: 'sign_in' })
      await done.catch(() => {})
      await vi.waitFor(async () => expect(await ask({ action: 'github' }))
        .toEqual({ login: null, missing: true, signInError: 'The GitHub CLI could not be installed here: update this computer, then try again.' }))
    })

    it('finds the code and the page in what gh prints', () => {
      expect(deviceCodeOf('! First copy your one-time code: B4B9-2B70\nOpen this URL to continue in your web browser: https://github.com/login/device\n'))
        .toEqual({ code: 'B4B9-2B70', url: 'https://github.com/login/device' })
      expect(deviceCodeOf('! First copy your one-time code: B4B9-2B70\n')).toEqual({ code: 'B4B9-2B70', url: 'https://github.com/login/device' })
      // Where gh found a clipboard (a Harness OS screen), it says it another way (gh 2.102, seen on one).
      expect(deviceCodeOf('! One-time code (8856-2E47) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n'))
        .toEqual({ code: '8856-2E47', url: 'https://github.com/login/device' })
      expect(deviceCodeOf('Press Enter to open github.com')).toBeNull()
    })
  })

  it('runs on the real filesystem and environment by default', async () => {
    vi.stubEnv('HARNESS_OS', '')
    const requests = startOsDevice(fakeCore())
    // The development machine is no Harness OS computer; the test reads it as one by its switch below.
    if (!(await import('node:fs')).existsSync(LIVE_UPDATE)) expect(await requests.os_device!({ action: 'status' }, OWNER)).toEqual({ harnessOs: false })
    vi.stubEnv('HARNESS_OS', '1')
    // Read, never written: there is none on a development machine.
    expect(await requests.os_device!({ action: 'wifi_result' }, OWNER)).toHaveProperty('result')
    child.spawn.mockReturnValue(Object.assign(new EventEmitter(), { unref: vi.fn() }))
    expect(await requests.os_device!({ action: 'update' }, OWNER)).toEqual({ started: true })
    child.execFile.mockImplementation((_f, _a, _o, done: (error: Error | null, stdout: string) => void) => { done(null, 'Home:50::\n'); return { stdin: Object.assign(new EventEmitter(), { end: vi.fn() }) } })
    expect(await requests.os_device!({ action: 'wifi_scan' }, OWNER)).toEqual({ networks: [{ ssid: 'Home', signal: 50, security: '', active: false }] })
  })
})

describe('the defaults that run commands', () => {
  afterEach(() => { vi.restoreAllMocks(); child.execFile.mockReset(); child.spawn.mockReset() })

  const fakeStdin = () => Object.assign(new EventEmitter(), { end: vi.fn() })

  it('runs a command bounded in time and output, its input on stdin', async () => {
    const stdin = fakeStdin()
    child.execFile.mockImplementationOnce((_f, _a, _o, done: (error: Error | null, stdout: string) => void) => { setImmediate(() => done(null, 'out')); return { stdin } })
    await expect(execBounded('nmcli', ['-t'], { timeout: 5, input: 'in' })).resolves.toBe('out')
    expect(child.execFile).toHaveBeenCalledWith('nmcli', ['-t'], { timeout: 5, maxBuffer: MAX_OUTPUT, killSignal: 'SIGKILL', encoding: 'utf8' }, expect.any(Function))
    expect(stdin.end).toHaveBeenCalledWith('in')
    stdin.emit('error', new Error('EPIPE'))
    child.execFile.mockImplementationOnce((_f, _a, _o, done: (error: Error | null, stdout: string) => void) => { setImmediate(() => done(new Error('timed out'), '')); return { stdin: fakeStdin() } })
    await expect(execBounded('nmcli', [], { timeout: 5 })).rejects.toThrow('timed out')
  })

  it('starts a command detached, its input written and closed, never waited on', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stdin = fakeStdin()
    const proc = Object.assign(new EventEmitter(), { stdin, unref: vi.fn() })
    child.spawn.mockReturnValueOnce(proc)
    spawnDetached('sudo', ['-n', 'x'], '{"password":"secret-pass"}')
    expect(child.spawn).toHaveBeenCalledWith('sudo', ['-n', 'x'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
    expect(stdin.end).toHaveBeenCalledWith('{"password":"secret-pass"}')
    expect(proc.unref).toHaveBeenCalled()
    stdin.emit('error', new Error('EPIPE'))
    proc.emit('error', new Error('spawn sudo ENOENT'))
    expect(error).toHaveBeenCalledWith('[os-device] could not start sudo:', 'spawn sudo ENOENT')
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-pass')
    const bare = Object.assign(new EventEmitter(), { unref: vi.fn() })
    child.spawn.mockReturnValueOnce(bare)
    spawnDetached('/usr/bin/harness', ['update'])
    expect(child.spawn).toHaveBeenLastCalledWith('/usr/bin/harness', ['update'], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
    expect(bare.unref).toHaveBeenCalled()
  })

  function ghProcess() {
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
    child.spawn.mockReturnValueOnce(proc)
    return proc
  }

  it('runs gh\'s device sign-in with no browser and no questions, the code read as it prints', async () => {
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0')
    vi.stubEnv('DISPLAY', ':0')
    const proc = ghProcess()
    const run = githubDeviceSignIn()
    const { env } = child.spawn.mock.calls[0][2] as { env: Record<string, string | undefined> }
    expect(env).not.toHaveProperty('WAYLAND_DISPLAY')
    expect(env).not.toHaveProperty('DISPLAY')
    vi.unstubAllEnvs()
    expect(child.spawn).toHaveBeenCalledWith(GH, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'], env: expect.objectContaining({ BROWSER: 'true', GH_PROMPT_DISABLED: '1' }) }))
    proc.stderr.emit('data', Buffer.from('! First copy your one-time code: '))
    proc.stderr.emit('data', Buffer.from('B4B9-2B70\nOpen this URL to continue in your web browser: https://github.com/login/device\n'))
    await expect(run.code).resolves.toEqual({ code: 'B4B9-2B70', url: 'https://github.com/login/device' })
    proc.emit('close', 0)
    await expect(run.done).resolves.toBeUndefined()
  })

  it('ends a device sign-in that failed with gh\'s last line, and stops one on request', async () => {
    const failed = ghProcess()
    const run = githubDeviceSignIn()
    failed.stderr.emit('data', Buffer.from('error connecting to github.com\n'))
    failed.emit('close', 1)
    await expect(run.code).rejects.toThrow('error connecting to github.com')
    await expect(run.done).rejects.toThrow('error connecting to github.com')
    const stopped = ghProcess()
    githubDeviceSignIn().stop()
    expect(stopped.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
