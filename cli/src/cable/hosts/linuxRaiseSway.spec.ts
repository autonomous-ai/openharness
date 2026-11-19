import { describe, expect, it } from 'vitest'
import { RECORDED_SWAY } from '../../testing/recordedSway.js'
import type { RaiseRun } from './linuxRaise.js'
import { createSwayRaise } from './linuxRaiseSway.js'

const SWAYMSG = '/usr/bin/swaymsg'
const SOCKET = RECORDED_SWAY.childEnv.SWAYSOCK
const { agent, other } = RECORDED_SWAY.pids
// The shells inside the two windows: each owns no node, so the chain goes past it to its terminal.
const AGENT_SHELL = 2209
const NO_MATCH = { code: RECORDED_SWAY.focusNoMatch.code, stdout: RECORDED_SWAY.focusNoMatch.stdout }
const listing = (stdout: string, code: number | null = 0) => ({ args: ['swaymsg', '-s', SOCKET, '-t', 'get_tree'], code, stdout })
// `[con_id=5]` was not recorded; sway answers it as it answered `[con_id=6]`.
const FOCUS_AGENT_BY_CON_ID = { ...RECORDED_SWAY.focusByConId, args: ['swaymsg', '-s', SOCKET, `[con_id=${RECORDED_SWAY.conIds.agent}] focus`] }

type Answer = { args: readonly string[]; code: number | null; stdout: string }

/** A made-up login on the recorded sway: `run` answers each recorded argv with its recorded output, and any other
 *  focus as sway answers a criteria that matches nothing. */
function login(answers: Answer[] = [listing(RECORDED_SWAY.tree), RECORDED_SWAY.focusByPid, RECORDED_SWAY.focusByConId, FOCUS_AGENT_BY_CON_ID]) {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = []
  const deps: RaiseRun = {
    onPath: (name) => (name === 'swaymsg' ? SWAYMSG : null),
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const found = answers.find((answer) => file === SWAYMSG && JSON.stringify(answer.args.slice(1)) === JSON.stringify(args))
      return found ? { code: found.code, stdout: found.stdout } : NO_MATCH
    },
  }
  return { deps, calls, focuses: () => calls.map((call) => call.args).filter((args) => args.at(-1)!.endsWith(' focus')).map((args) => args.at(-1)) }
}

/** A tree of [windows] under one workspace, each `{ id, pid, app_id, window_properties }` as sway prints them. */
function treeOf(...windows: object[]) {
  return JSON.stringify({ id: 1, type: 'root', nodes: [{ id: 2, type: 'workspace', nodes: windows, floating_nodes: [] }], floating_nodes: [] })
}

describe('createSwayRaise', () => {
  it('lists the tree through the socket, then focuses the window of the agent\'s chain by pid', async () => {
    const { deps, calls } = login()
    expect(await createSwayRaise(deps, SOCKET).raise({ pids: [agent], classes: [] })).toBe(true)
    expect(calls.map((call) => [call.file, ...call.args])).toEqual([
      ['/usr/bin/swaymsg', ...listing('').args.slice(1)],
      ['/usr/bin/swaymsg', ...RECORDED_SWAY.focusByPid.args.slice(1)],
    ])
  })

  it('takes the first of the chain that owns a window, past a nearer pid that owns none', async () => {
    const { deps, focuses } = login()
    expect(await createSwayRaise(deps, SOCKET).raise({ pids: [AGENT_SHELL, agent, other], classes: ['XTerm'] })).toBe(true)
    expect(focuses()).toEqual([`[pid=${agent}] focus`])
  })

  it('finds a window in floating_nodes by its pid', async () => {
    // `[pid=<other>] focus` was not recorded; sway answers it as it answered `agent`'s.
    const { deps, focuses } = login([listing(RECORDED_SWAY.tree), { ...RECORDED_SWAY.focusByPid, args: ['swaymsg', '-s', SOCKET, `[pid=${other}] focus`] }])
    expect(await createSwayRaise(deps, SOCKET).raise({ pids: [other], classes: [] })).toBe(true)
    expect(focuses()).toEqual([`[pid=${other}] focus`])
  })

  it('raises an XWayland window, which has no app_id, by its X11 class without case', async () => {
    const { deps, focuses } = login()
    expect(await createSwayRaise(deps, SOCKET).raise({ pids: [99999], classes: ['xterm'] })).toBe(true)
    expect(focuses()).toEqual([RECORDED_SWAY.focusByConId.args[3]])
  })

  it('raises a native window by its app_id without case, the first class that matches', async () => {
    const { deps, focuses } = login()
    expect(await createSwayRaise(deps, SOCKET).raise({ pids: [], classes: ['org.wezfurlong.wezterm', 'FOOT', 'xterm'] })).toBe(true)
    expect(focuses()).toEqual([`[con_id=${RECORDED_SWAY.conIds.agent}] focus`])
  })

  it('answers false with no second command when neither a pid nor a class matches', async () => {
    const { deps, calls } = login()
    expect(await createSwayRaise(deps, SOCKET).raise({ pids: [99999, AGENT_SHELL], classes: ['Code'] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('answers false when the focus exits non-zero, as when the window closed after the listing', async () => {
    const { deps, focuses } = login([listing(RECORDED_SWAY.tree), { ...RECORDED_SWAY.focusNoMatch, args: RECORDED_SWAY.focusByPid.args }])
    expect(await createSwayRaise(deps, SOCKET).raise({ pids: [agent], classes: [] })).toBe(false)
    expect(focuses()).toEqual([`[pid=${agent}] focus`])
  })

  it.each([
    ['fails, as on a stale socket', listing('', RECORDED_SWAY.staleSocket.code)],
    ['is over the runner\'s buffer (no exit code)', listing('', null)],
    ['is not JSON', listing('{"id": 1, "nodes": [')],
    ['is not a tree', listing('[]')],
    ['is null', listing('null')],
    ['has nodes that are not a list', listing('{"id": 1, "nodes": {"id": 5, "pid": 2205}}')],
  ])('answers false with no focus when the listing %s', async (_, answer) => {
    const { deps, calls } = login([answer])
    expect(await createSwayRaise(deps, SOCKET).raise({ pids: [agent], classes: ['foot'] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('never lets a pid or a node id out of form reach a command', async () => {
    const tree = treeOf(
      { id: 7, pid: -3, app_id: 'a' },
      { id: 8, pid: 2.5, app_id: 'b' },
      { id: -1, pid: 4000, app_id: 'c' },
      { id: 1.5, pid: 4001, app_id: 'd' },
      { id: '9] kill; [con_id=9', pid: 4002, app_id: 'e' },
      { id: 1e20, pid: 4003, app_id: 'f' },
      { id: 10, pid: 0, app_id: 'g' },
    )
    const { deps, calls } = login([listing(tree)])
    expect(await createSwayRaise(deps, SOCKET).raise({ pids: [-3, 2.5, 0, Number.NaN], classes: ['c', 'd', 'e', 'f'] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('walks at most 32 levels deep', async () => {
    const nest = (depth: number, window: object): object => (depth === 0 ? window : { id: 100 + depth, nodes: [nest(depth - 1, window)] })
    const deepest = { id: 1, nodes: [nest(31, { id: 50, pid: 4100, app_id: 'deep' })] }
    const tooDeep = { id: 1, nodes: [nest(32, { id: 51, pid: 4101, app_id: 'deeper' })] }
    const reached = login([listing(JSON.stringify(deepest))])
    await createSwayRaise(reached.deps, SOCKET).raise({ pids: [4100], classes: [] })
    expect(reached.focuses()).toEqual(['[pid=4100] focus'])
    const past = login([listing(JSON.stringify(tooDeep))])
    expect(await createSwayRaise(past.deps, SOCKET).raise({ pids: [4101], classes: ['deeper'] })).toBe(false)
    expect(past.calls).toHaveLength(1)
  })

  it('walks at most 4096 nodes', async () => {
    const filler = (count: number) => Array.from({ length: count }, (_, i) => ({ id: 1000 + i, type: 'con' }))
    // The root is the first node: the window after 4094 others is the 4096th, after 4095 the 4097th.
    const last = login([listing(JSON.stringify({ id: 1, nodes: [...filler(4094), { id: 60, pid: 4200, app_id: 'x' }] }))])
    await createSwayRaise(last.deps, SOCKET).raise({ pids: [4200], classes: [] })
    expect(last.focuses()).toEqual(['[pid=4200] focus'])
    const past = login([listing(JSON.stringify({ id: 1, nodes: [...filler(4095), { id: 61, pid: 4201, app_id: 'x' }] }))])
    expect(await createSwayRaise(past.deps, SOCKET).raise({ pids: [4201], classes: ['x'] })).toBe(false)
    expect(past.calls).toHaveLength(1)
  })

  it('gives every call the runner\'s 10 s', async () => {
    const { deps, calls } = login()
    await createSwayRaise(deps, SOCKET).raise({ pids: [], classes: ['xterm'] })
    expect(calls.map((call) => call.timeoutMs)).toEqual([10_000, 10_000])
  })

  it('answers false and runs nothing without swaymsg on PATH', async () => {
    const { deps, calls } = login()
    deps.onPath = () => null
    expect(await createSwayRaise(deps, SOCKET).raise({ pids: [agent], classes: ['foot'] })).toBe(false)
    expect(calls).toEqual([])
  })

  it('answers false and does not throw when the runner rejects', async () => {
    const { deps } = login()
    deps.run = async () => { throw new Error('spawn failed') }
    expect(await createSwayRaise(deps, SOCKET).raise({ pids: [agent], classes: ['foot'] })).toBe(false)
  })
})
