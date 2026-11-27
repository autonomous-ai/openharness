import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserHelp, START_STOP_USAGE } from './browserArgs.js'
import { OUTPUT_CAP_CHARS } from './browserOutput.js'
import { browserCommand } from './browser.js'
import { AgentClientError, type Where } from './daemon.js'
import type { PaneProbe } from '../lib/callerPane.js'

const HERE: Where = { port: 18473, dataDir: '/data', machineId: 'm', harnessPane: true }
/** The command, its shell, and the tmux server whose pane %7 runs that shell. */
const PROBE: PaneProbe = {
  ancestors: () => [{ pid: 300, command: 'node' }, { pid: 200, command: 'zsh' }, { pid: 100, command: 'tmux' }],
  panes: () => [{ pane: '%3', pid: 150 }, { pane: '%7', pid: 200 }],
}
/** A shell no tmux server runs: a person's terminal, or a pty host's pane. */
const NO_TMUX: PaneProbe = { ancestors: () => [{ pid: 300, command: 'node' }, { pid: 200, command: 'zsh' }], panes: () => null }

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
const tmp = () => { const folder = mkdtempSync(join(tmpdir(), 'harness-browser-')); folders.push(folder); return folder }

type Answer = Record<string, unknown> | Error

/** `harness browser …` against a fake daemon that records each request and answers [answer]. */
async function run(argv: string[], options: {
  answer?: Answer; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; probe?: PaneProbe; stdin?: string; open?: Error
} = {}) {
  const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough()
  let out = '', err = ''
  stdout.on('data', (chunk) => { out += String(chunk) })
  stderr.on('data', (chunk) => { err += String(chunk) })
  if (options.stdin !== undefined) stdin.end(options.stdin)
  const requests: Array<{ type: string; payload: Record<string, unknown>; timeoutMs?: number }> = []
  const close = vi.fn()
  const open = vi.fn(async () => {
    if (options.open) throw options.open
    return {
      machineId: 'm',
      close,
      request: async (type: string, payload: Record<string, unknown> = {}, timeoutMs?: number) => {
        requests.push({ type, payload, timeoutMs })
        const answer = options.answer ?? { ok: true, text: 'Clicked' }
        if (answer instanceof Error) throw answer
        return answer
      },
    }
  })
  const where = vi.fn(() => HERE)
  const code = await browserCommand(argv, { stdout, stderr, stdin }, {
    platform: options.platform ?? 'darwin', env: options.env ?? { TMUX_PANE: '%7', TMPDIR: tmp() },
    probe: options.probe ?? PROBE, where, open: open as never,
  })
  return { code, out, err, requests, open, where, close }
}

describe('harness browser', () => {
  it('--help prints every command and opens no daemon', async () => {
    for (const argv of [['--help'], ['-h'], []]) {
      const r = await run(argv)
      expect(r.code).toBe(0)
      expect(r.out).toBe(`${browserHelp()}\n`)
      expect(r.err).toBe('')
      expect(r.open).not.toHaveBeenCalled()
    }
  })

  it('start and stop exit 2 with the line that names the person', async () => {
    for (const verb of ['start', 'stop']) {
      const r = await run([verb])
      expect(r.code).toBe(2)
      expect(r.err).toBe(`${START_STOP_USAGE}\n`)
      expect(r.out).toBe('')
      expect(r.open).not.toHaveBeenCalled()
    }
  })

  it('a wrong command exits 2 with its usage', async () => {
    const unknown = await run(['fly'])
    expect(unknown.code).toBe(2)
    expect(unknown.err).toMatch(/^Usage: harness browser/)
    const missing = await run(['click'])
    expect(missing.code).toBe(2)
    expect(missing.err).toBe('Usage: harness browser click <ref>\n')
    expect(missing.open).not.toHaveBeenCalled()
  })

  it('on Windows it prints its line, exits 5 and starts nothing', async () => {
    for (const argv of [['--help'], ['snapshot'], ['start'], ['fly']]) {
      const probe = { ancestors: vi.fn(() => null), panes: vi.fn(() => null) }
      const r = await run(argv, { platform: 'win32', probe })
      expect(r.code).toBe(5)
      expect(r.err).toBe("Browser doesn't run on Windows yet.\n")
      expect(r.out).toBe('')
      expect(probe.ancestors).not.toHaveBeenCalled()
      expect(r.open).not.toHaveBeenCalled()
    }
  })

  it('with no pane, and with a TMUX_PANE that names another pane, it exits 5 and asks nothing', async () => {
    const cases: Array<{ env: NodeJS.ProcessEnv; probe: PaneProbe }> = [
      // A person's terminal.
      { env: {}, probe: NO_TMUX },
      // A pty host's pane on macOS or Linux: HARNESS_PANE alone proves nothing.
      { env: { HARNESS_PANE: 'p1' }, probe: NO_TMUX },
      // TMUX_PANE names another agent's pane.
      { env: { TMUX_PANE: '%3' }, probe: PROBE },
    ]
    for (const { env, probe } of cases) {
      const r = await run(['snapshot'], { env, probe })
      expect(r.code).toBe(5)
      expect(r.err).toBe('Run harness browser from your own Harness pane.\n')
      expect(r.open).not.toHaveBeenCalled()
    }
  })

  // Found with a real Codex agent: a piped or `;` command runs in Codex's sandbox, where ps and the tmux socket are refused.
  // Exit 5 made it give up; exit 1 with the proof's reason lets it run the command again outside the sandbox.
  it('a pane its environment keeps it from proving is the proof\'s reason, exit 1, and asks nothing', async () => {
    const cases: Array<{ env: NodeJS.ProcessEnv; probe: PaneProbe }> = [
      // ps unreadable.
      { env: { TMUX: '/private/tmp/tmux-501/default,1,0', TMUX_PANE: '%7' }, probe: { ancestors: () => null, panes: () => null } },
      // The tmux socket refused.
      { env: { TMUX: '/private/tmp/tmux-501/default,1,0', TMUX_PANE: '%7' }, probe: { ...PROBE, panes: () => null } },
    ]
    for (const { env, probe } of cases) {
      const r = await run(['snapshot'], { env, probe })
      expect(r.code).toBe(1)
      expect(r.err).toBe('Harness could not tell which pane this command runs in, so it did not run it. Run it as your harness gave it, in its own pane.\n')
      expect(r.open).not.toHaveBeenCalled()
    }
  })

  it('the request carries the proven pane, its parents and the tool\'s call, and never an agent id', async () => {
    const r = await run(['click', 'e12'], { env: { TMUX_PANE: '%7', TMPDIR: tmp(), HARNESS_AGENT_ID: 'a-other' } })
    expect(r.code).toBe(0)
    expect(r.out).toBe('Clicked\n')
    expect(r.where).toHaveBeenCalledWith('%7')
    expect(r.requests).toHaveLength(1)
    expect(r.requests[0]!.type).toBe('agent_browser_run')
    expect(r.requests[0]!.payload).toEqual({ pane: '%7', ancestors: [300, 200, 100], command: 'click', args: { ref: 'e12' } })
    expect(r.close).toHaveBeenCalled()
  })

  describe('the Contract\'s second table', () => {
    const rows: Array<[string, Answer, number, 'out' | 'err', string]> = [
      ['ok', { ok: true, text: 'https://example.com · Example' }, 0, 'out', 'https://example.com · Example'],
      ['ok with failed', { ok: true, text: 'Element not found; take a new snapshot', failed: true }, 1, 'err', 'Element not found; take a new snapshot'],
      ['NOT_READY starting', { error: 'NOT_READY', state: 'starting' }, 1, 'err', 'Browser is starting'],
      ['NOT_READY setup', { error: 'NOT_READY', state: 'setup' }, 1, 'err', 'Browser is being set up'],
      ['NOT_READY needs_setup', { error: 'NOT_READY', state: 'needs_setup' }, 1, 'err', "Browser isn't set up"],
      ['NOT_READY podman_down', { error: 'NOT_READY', state: 'podman_down' }, 1, 'err', 'Podman is not running'],
      ['NOT_READY of a state this CLI does not know', { error: 'NOT_READY', state: 'newer_state' }, 1, 'err', "Browser isn't available right now"],
      ['BUSY', { error: 'BUSY' }, 1, 'err', 'Browser is busy. Try again.'],
      ['TOOL_TIMEOUT', { error: 'TOOL_TIMEOUT' }, 1, 'err', 'snapshot timed out'],
      ['TOOL_FAILED', { error: 'TOOL_FAILED' }, 1, 'err', 'Browser is not reachable'],
      ['UNSUPPORTED', { error: 'UNSUPPORTED' }, 1, 'err', "Browser isn't available right now"],
      ['LOCAL_ONLY', { error: 'LOCAL_ONLY' }, 1, 'err', "Browser isn't available right now"],
      ['INVALID_REQUEST', { error: 'INVALID_REQUEST' }, 1, 'err', "Browser isn't available right now"],
      ['any other', { error: 'SOMETHING_NEW' }, 1, 'err', "Browser isn't available right now"],
      ['no answer at all', {}, 1, 'err', "Browser isn't available right now"],
      ['OFF', { error: 'OFF' }, 4, 'err', 'Your browser is off. Ask your person to start it: Browser in your chat.'],
      ['STOPPED', { error: 'STOPPED' }, 4, 'err', 'Your person stopped your browser.'],
      ['NOT_ALLOWED', { error: 'NOT_ALLOWED' }, 5, 'err', "Browser isn't available for this agent."],
      ['NO_AGENT', { error: 'NO_AGENT' }, 5, 'err', 'Run harness browser from your own Harness pane.'],
      ['NOT_ON_WINDOWS', { error: 'NOT_ON_WINDOWS' }, 5, 'err', "Browser doesn't run on Windows yet."],
    ]
    for (const [name, answer, code, stream, line] of rows) {
      it(`${name}: exit ${code}, on standard ${stream === 'out' ? 'output' : 'error'}`, async () => {
        const r = await run(['snapshot'], { answer })
        expect(r.code).toBe(code)
        expect(stream === 'out' ? r.out : r.err).toBe(`${line}\n`)
        expect(stream === 'out' ? r.err : r.out).toBe('')
      })
    }
  })

  it('navigate waits 75 s, wait 45 s, the rest 35 s, and says <command> timed out after', async () => {
    const cases: Array<[string[], number]> = [
      [['navigate', 'https://example.com'], 75_000], [['wait', 'Inbox'], 45_000], [['wait', '--ms', '2000'], 45_000],
      [['snapshot'], 35_000], [['click', 'e1'], 35_000], [['screenshot'], 35_000],
    ]
    for (const [argv, ms] of cases) {
      const r = await run(argv, { answer: new AgentClientError('TIMEOUT', 'Harness did not answer agent_browser_run in time. Try again.') })
      expect(r.requests[0]!.timeoutMs).toBe(ms)
      expect(r.code).toBe(1)
      expect(r.err).toBe(`${argv[0]} timed out\n`)
      expect(r.close).toHaveBeenCalled()
    }
  })

  it('a screenshot prints only its path and the file is the JPEG', async () => {
    const TMPDIR = tmp()
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])
    const r = await run(['screenshot'], { env: { TMUX_PANE: '%7', TMPDIR }, answer: { ok: true, text: 'Screenshot', image: jpeg.toString('base64') } })
    expect(r.code).toBe(0)
    const path = r.out.trimEnd()
    expect(r.out).toBe(`${path}\n`)
    expect(path.startsWith(join(TMPDIR, 'browser', 'shot-'))).toBe(true)
    expect(path.endsWith('.jpg')).toBe(true)
    expect(readFileSync(path)).toEqual(jpeg)
    expect(r.err).toBe('')
  })

  it('long output is cut and names its file', async () => {
    const TMPDIR = tmp()
    const text = 'x'.repeat(OUTPUT_CAP_CHARS + 500)
    const r = await run(['snapshot'], { env: { TMUX_PANE: '%7', TMPDIR }, answer: { ok: true, text } })
    expect(r.code).toBe(0)
    const match = /\nCut at \d+ characters\. The whole output: (.+)\n$/.exec(r.out)
    expect(match).not.toBeNull()
    expect(r.out.startsWith('x'.repeat(OUTPUT_CAP_CHARS))).toBe(true)
    expect(readFileSync(match![1]!, 'utf8')).toBe(text)
  })

  it('type - sends standard input as the text', async () => {
    const text = 'a "b"\nc --submit'
    const r = await run(['type', 'e7', '-', '--submit'], { stdin: text })
    expect(r.code).toBe(0)
    expect(r.requests[0]!.payload.args).toEqual({ ref: 'e7', text, submit: true })
    const empty = await run(['type', 'e7', '-'], { stdin: '' })
    expect(empty.requests[0]!.payload.args).toEqual({ ref: 'e7', text: '' })
  })

  // On Linux a plain agent has no TMPDIR: its screenshots go in the folder Harness keeps for its agents' files.
  it('with no TMPDIR, a screenshot is saved in the agents\' folder', async () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
    const data = tmp()
    const r = await run(['screenshot'], { env: { TMUX_PANE: '%7', ADAPTER_DATA_DIR: data }, answer: { ok: true, text: '', image } })
    expect(r.code, r.err).toBe(0)
    expect(r.out.trim().startsWith(join(data, 'agent-tmp', 'browser', 'shot-'))).toBe(true)
  })

  it('a folder that cannot be written is one line and exit 1', async () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
    const data = tmp()
    mkdirSync(join(data, 'agent-tmp'))
    writeFileSync(join(data, 'agent-tmp', 'browser'), 'a file')
    const unset = await run(['screenshot'], { env: { TMUX_PANE: '%7', ADAPTER_DATA_DIR: data }, answer: { ok: true, text: '', image } })
    expect(unset.code).toBe(1)
    expect(unset.err.split('\n')).toHaveLength(2)
    expect(unset.err).toMatch(/^Can't save browser files/)
    expect(unset.out).toBe('')
    const TMPDIR = tmp()
    writeFileSync(join(TMPDIR, 'browser'), 'a file')
    const file = await run(['snapshot'], { env: { TMUX_PANE: '%7', TMPDIR }, answer: { ok: true, text: 'y'.repeat(OUTPUT_CAP_CHARS + 1) } })
    expect(file.code).toBe(1)
    expect(file.err).toMatch(/^Can't save browser files[^\n]*\n$/)
    expect(file.out).toBe('')
  })

  it('the daemon unreachable is exit 1 with the agent verbs\' line', async () => {
    const line = 'Harness is not running here. Start it with `harness start`.'
    const r = await run(['snapshot'], { open: new AgentClientError('DAEMON_UNREACHABLE', line) })
    expect(r.code).toBe(1)
    expect(r.err).toBe(`${line}\n`)
    expect(r.out).toBe('')
  })
})
