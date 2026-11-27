import { describe, expect, it, vi } from 'vitest'
import { isUsbConsoleUser, linuxSeatOwner, type SeatDeps } from './usbConsoleUser.js'

describe('physical USB ownership', () => {
  it('follows harness-serial on Windows: the console session owns the dial', () => {
    expect(isUsbConsoleUser({ platform: 'win32', windowsConsole: () => true })).toBe(true)
    expect(isUsbConsoleUser({ platform: 'win32', windowsConsole: () => false })).toBe(false)
  })

  it('allows the active macOS account and excludes a daemon left in another login', () => {
    const consoleUid = () => 501
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 501, consoleUid })).toBe(true)
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 502, consoleUid })).toBe(false)
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 0, consoleUid })).toBe(false)
  })

  it('releases the port at the login window or when console ownership cannot be read', () => {
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 501, consoleUid: () => 0 })).toBe(false)
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 0, consoleUid: () => 0 })).toBe(false)
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 501, consoleUid: () => { throw new Error('unavailable') } })).toBe(false)
  })

  it('isUsbConsoleUser on Linux answers the seat\'s owner, never the macOS console', () => {
    const consoleUid = vi.fn(() => { throw new Error('no macOS console') })
    expect(isUsbConsoleUser({ platform: 'linux', uid: 1000, consoleUid, linuxSeat: () => false })).toBe(false)
    expect(isUsbConsoleUser({ platform: 'linux', uid: 1000, consoleUid, linuxSeat: () => true })).toBe(true)
    expect(consoleUid).not.toHaveBeenCalled()
  })

  it('isUsbConsoleUser on Linux tells the seat reader whether a dial is on USB', () => {
    const linuxSeat = vi.fn((_dialHere: boolean) => true)
    isUsbConsoleUser({ platform: 'linux', dialHere: false, linuxSeat })
    isUsbConsoleUser({ platform: 'linux', dialHere: true, linuxSeat })
    expect(linuxSeat.mock.calls).toEqual([[false], [true]])
  })
})

type Answer = { code: number; stdout: string } | Error

const SHOW_SEAT = ['show-seat', 'seat0', '--property=ActiveSession', '--value']
const showSession = (id: string) => ['show-session', id, '--property=User', '--value']

/** A fake loginctl answering by argv, and a clock the test moves. */
function fakeLoginctl(answer: (args: string[]) => Answer | Promise<Answer>) {
  const calls: [string, string[], number][] = []
  let time = 0
  const deps = (uid: number | undefined): SeatDeps => ({
    run: async (file, args, timeoutMs) => {
      calls.push([file, args, timeoutMs])
      const reply = await answer(args)
      if (reply instanceof Error) throw reply
      return reply
    },
    now: () => time,
    uid,
  })
  return { calls, deps, at: (ms: number) => { time = ms } }
}

const seatOf = (user: string) => (args: string[]): Answer =>
  args[0] === 'show-seat' ? { code: 0, stdout: '2\n' } : { code: 0, stdout: `${user}\n` }

// The fake answers at once, so one turn of the event loop lets a reading's last step land.
const settled = () => new Promise((resolve) => setImmediate(resolve))

describe('the Linux seat\'s owner', () => {
  it('on Linux the user of seat0\'s active session owns the dial', async () => {
    const loginctl = fakeLoginctl(seatOf('1000'))
    const owner = linuxSeatOwner(loginctl.deps(1000))
    expect(owner(true)).toBe(true)
    await vi.waitFor(() => expect(loginctl.calls).toHaveLength(2))
    await settled()
    expect(owner(true)).toBe(true)
    expect(loginctl.calls).toEqual([
      ['loginctl', SHOW_SEAT, 10_000],
      ['loginctl', showSession('2'), 10_000],
    ])

    const other = linuxSeatOwner(fakeLoginctl(seatOf('1000')).deps(1001))
    expect(other(true)).toBe(true)
    await vi.waitFor(() => expect(other(true)).toBe(false))
  })

  const enoent = Object.assign(new Error('spawn loginctl ENOENT'), { code: 'ENOENT' })
  it.each<[string, (args: string[]) => Answer, boolean]>([
    ['no loginctl', () => enoent, false],
    ['no seat0', () => ({ code: 1, stdout: '' }), false],
    ['no active session', () => ({ code: 0, stdout: '\n' }), false],
    ['an id with a separator', () => ({ code: 0, stdout: '2;x\n' }), false],
    ['an id that is a path', () => ({ code: 0, stdout: '../2\n' }), false],
    ['an id of 65 characters', () => ({ code: 0, stdout: `${'a'.repeat(65)}\n` }), false],
    ['no such session', (args) => args[0] === 'show-seat' ? { code: 0, stdout: '2\n' } : { code: 1, stdout: '' }, true],
    ['no user', seatOf(''), true],
    ['a user that is not a uid', seatOf('u'), true],
  ])('a computer with no seat, no logind or no active session keeps the dial: %s', async (_, broken, asksSession) => {
    // The first reading hands the seat to someone else, so a true afterwards is the broken reading's answer.
    let answer = seatOf('1000')
    const loginctl = fakeLoginctl((args) => answer(args))
    const owner = linuxSeatOwner(loginctl.deps(1001))
    owner(true)
    await vi.waitFor(() => expect(owner(true)).toBe(false))

    answer = broken
    loginctl.at(8_000)
    owner(true)
    await vi.waitFor(() => expect(owner(true)).toBe(true))
    expect(loginctl.calls.slice(2).map(([, args]) => args[0])).toEqual(asksSession ? ['show-seat', 'show-session'] : ['show-seat'])
  })

  it('starts no reading while no dial is on USB, and reads once one is', async () => {
    const loginctl = fakeLoginctl(seatOf('1000'))
    const owner = linuxSeatOwner(loginctl.deps(1001))
    loginctl.at(8_000)
    expect(owner(false)).toBe(true)
    await settled()
    expect(loginctl.calls).toHaveLength(0)
    owner(true)
    await vi.waitFor(() => expect(owner(true)).toBe(false))
  })

  it('a daemon with no uid keeps the dial', async () => {
    const loginctl = fakeLoginctl(seatOf('1000'))
    const owner = linuxSeatOwner(loginctl.deps(undefined))
    owner(true)
    await vi.waitFor(() => expect(loginctl.calls).toHaveLength(2))
    await settled()
    expect(owner(true)).toBe(true)
  })

  it('reads again only 8 s after the last reading began, one at a time', async () => {
    let user = '1000'
    let hold = false
    let release = () => {}
    const loginctl = fakeLoginctl(async (args) => {
      if (hold && args[0] === 'show-seat') await new Promise<void>((resolve) => { release = resolve })
      return seatOf(user)(args)
    })
    const owner = linuxSeatOwner(loginctl.deps(1000))
    owner(true)
    await vi.waitFor(() => expect(loginctl.calls).toHaveLength(2))
    await settled()

    loginctl.at(7_999)
    expect(owner(true)).toBe(true)
    await settled()
    expect(loginctl.calls).toHaveLength(2)

    hold = true
    loginctl.at(8_000)
    expect(owner(true)).toBe(true)
    expect(loginctl.calls).toHaveLength(3)

    loginctl.at(16_000)
    expect(owner(true)).toBe(true)
    await settled()
    expect(loginctl.calls).toHaveLength(3)

    user = '1001'
    hold = false
    release()
    await vi.waitFor(() => expect(owner(true)).toBe(false))
  })
})
