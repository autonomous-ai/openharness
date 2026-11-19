import { describe, expect, it } from 'vitest'
import { RECORDED_WMCTRL } from '../../testing/recordedWmctrl.js'
import { createX11Raise } from './linuxRaiseX11.js'
import type { RaiseRun, RaiseTarget } from './linuxRaise.js'

type Answer = { code: number | null; stdout: string }
interface Call { argv: string[]; timeoutMs: number }

const ENV = '/usr/bin/env'
const DISPLAY = ':99'
const XAUTHORITY = '/home/u/.Xauthority'
const { agent, other } = RECORDED_WMCTRL.pids
const AGENT_ID = '0x0020000c'
const OTHER_ID = '0x0080000c'
const NOPID_ID = '0x00a0001b'

/** A recorded argv as the raise runs it: `env` as PATH resolved it. */
const asRun = (argv: readonly string[]) => [ENV, ...argv.slice(1)]
const key = (argv: readonly string[]) => JSON.stringify(argv)
const lpxArgs = (xauthority?: string) =>
  [ENV, `DISPLAY=${DISPLAY}`, ...(xauthority === undefined ? [] : [`XAUTHORITY=${xauthority}`]), 'wmctrl', '-lpx']
const activateArgs = (id: string) => [ENV, `DISPLAY=${DISPLAY}`, `XAUTHORITY=${XAUTHORITY}`, 'wmctrl', '-i', '-a', id]

const LISTED: Answer = { code: 0, stdout: RECORDED_WMCTRL.lpx }
const ACTIVATED: Answer = { code: RECORDED_WMCTRL.activate.code, stdout: RECORDED_WMCTRL.activate.stdout }

/** An X11 login that answers each command by its whole argv as recorded, else exit 1; `env` on PATH unless said, and
 *  the recorded cookie unless `auth` is null. */
function x11({ listing = LISTED, answers = {}, env = true, auth = XAUTHORITY as string | null, throws = false }:
  { listing?: Answer; answers?: Record<string, Answer>; env?: boolean; auth?: string | null; throws?: boolean } = {}) {
  const xauthority = auth ?? undefined
  const calls: Call[] = []
  const known: Record<string, Answer> = {
    [key(lpxArgs(xauthority))]: listing,
    [key(asRun(RECORDED_WMCTRL.activate.args))]: ACTIVATED,
    [key(activateArgs(OTHER_ID))]: ACTIVATED,
    [key(activateArgs(NOPID_ID))]: ACTIVATED,
    ...answers,
  }
  const deps: RaiseRun = {
    run: async (file, args, timeoutMs) => {
      calls.push({ argv: [file, ...args], timeoutMs })
      if (throws) throw new Error('spawn failed')
      return known[key([file, ...args])] ?? { code: 1, stdout: '' }
    },
    onPath: (name) => (env && name === 'env' ? ENV : null),
  }
  const backend = createX11Raise(deps, DISPLAY, xauthority)
  return { calls, raise: (target: Partial<RaiseTarget>) => backend.raise({ pids: [], classes: [], ...target }) }
}

const argvs = (calls: Call[]) => calls.map((call) => call.argv)

describe('createX11Raise', () => {
  it('raises the window of the agent process through wmctrl, each part one argument', async () => {
    const { calls, raise } = x11()
    expect(await raise({ pids: [agent] })).toBe(true)
    expect(argvs(calls)).toEqual([asRun(RECORDED_WMCTRL.lpxArgs), asRun(RECORDED_WMCTRL.activate.args)])
  })

  it('gives every call the run timeout', async () => {
    const { calls, raise } = x11()
    await raise({ pids: [other] })
    expect(calls.map((call) => call.timeoutMs)).toEqual([10_000, 10_000])
  })

  it('leaves XAUTHORITY out when the login has none', async () => {
    const { calls, raise } = x11({ auth: null, answers: { [key([ENV, `DISPLAY=${DISPLAY}`, 'wmctrl', '-i', '-a', AGENT_ID])]: ACTIVATED } })
    expect(await raise({ pids: [agent] })).toBe(true)
    expect(argvs(calls)).toEqual([lpxArgs(), [ENV, `DISPLAY=${DISPLAY}`, 'wmctrl', '-i', '-a', AGENT_ID]])
  })

  it('takes the first pid that owns a window over a nearer one that owns none', async () => {
    const { calls, raise } = x11()
    expect(await raise({ pids: [4242, other, agent] })).toBe(true)
    expect(argvs(calls)[1]).toEqual(activateArgs(OTHER_ID))
  })

  it('follows the order of the pids, not of the rows', async () => {
    const { calls, raise } = x11()
    expect(await raise({ pids: [other, agent] })).toBe(true)
    expect(argvs(calls)[1]).toEqual(activateArgs(OTHER_ID))
  })

  it.each([
    ['the class', ['XMESSAGE'], NOPID_ID],
    ['the instance', ['NoPid'], NOPID_ID],
    ['a later spelling', ['nothing', 'xterm'], AGENT_ID],
  ])('raises by %s, without case, when no pid matches', async (_, classes, id) => {
    const { calls, raise } = x11()
    expect(await raise({ pids: [4242], classes })).toBe(true)
    expect(argvs(calls)[1]).toEqual(activateArgs(id))
  })

  it('matches a spelling only as the whole class or instance', async () => {
    const { calls, raise } = x11()
    expect(await raise({ classes: ['term', 'xterm.XTerm', 'XTer'] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('matches nothing by a pid of 0, which a window that names none shows', async () => {
    const { calls, raise } = x11()
    expect(await raise({ pids: [0] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  // pid 1 holds every orphan: a window it owns is no agent's.
  it('matches nothing by pid 1', async () => {
    const { calls, raise } = x11({ listing: { code: 0, stdout: `${RECORDED_WMCTRL.lpx}0x00c00001  0 1      init.Init             box init\n` } })
    expect(await raise({ pids: [1] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('answers false with no second command when neither pid nor class matches', async () => {
    const { calls, raise } = x11()
    expect(await raise({ pids: [4242], classes: ['Code'] })).toBe(false)
    expect(argvs(calls)).toEqual([asRun(RECORDED_WMCTRL.lpxArgs)])
  })

  it.each<[string, Answer]>([
    ['no display', { code: RECORDED_WMCTRL.noDisplay.code, stdout: RECORDED_WMCTRL.noDisplay.stdout }],
    ['a killed or unstarted run', { code: null, stdout: '' }],
    ['a listing over the runner buffer', { code: null, stdout: RECORDED_WMCTRL.lpx }],
    ['a listing that is no listing', { code: 0, stdout: 'Cannot get client list properties.\n' }],
  ])('answers false with no second command on %s', async (_, listing) => {
    const { calls, raise } = x11({ listing })
    expect(await raise({ pids: [agent], classes: ['XTerm'] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('answers false when the server refuses the cookie', async () => {
    const { calls, raise } = x11({
      auth: '/work/none',
      listing: { code: RECORDED_WMCTRL.noAuth.code, stdout: RECORDED_WMCTRL.noAuth.stdout },
    })
    expect(await raise({ pids: [agent] })).toBe(false)
    expect(argvs(calls)).toEqual([asRun(RECORDED_WMCTRL.noAuth.args)])
  })

  it('answers false when the window is gone by the activate', async () => {
    const { calls, raise } = x11({
      listing: { code: 0, stdout: '0x0badf00d  0 2259   xterm.XTerm           box agent\n' },
      answers: { [key(asRun(RECORDED_WMCTRL.missing.args))]: { code: RECORDED_WMCTRL.missing.code, stdout: RECORDED_WMCTRL.missing.stdout } },
    })
    expect(await raise({ pids: [agent] })).toBe(false)
    expect(argvs(calls)[1]).toEqual(asRun(RECORDED_WMCTRL.missing.args))
  })

  it.each([
    ['too long', '0x0020000c0'],
    ['in capitals', '0x0020000C'],
    ['not hex', '0x0020zz0c'],
    ['an option', '-0x0020000c'],
  ])('never runs an id %s', async (_, id) => {
    const { calls, raise } = x11({ listing: { code: 0, stdout: `${id}  0 2259   xterm.XTerm           box agent\n` } })
    expect(await raise({ pids: [agent], classes: ['XTerm'] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('answers false with no command when env is not on PATH', async () => {
    const { calls, raise } = x11({ env: false })
    expect(await raise({ pids: [agent] })).toBe(false)
    expect(calls).toEqual([])
  })

  it('answers false rather than throwing when the run throws', async () => {
    const { raise } = x11({ throws: true })
    await expect(raise({ pids: [agent] })).resolves.toBe(false)
  })
})
