import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readZip } from '../testing/readZip.js'
import { logsExportCommand, type LogsExportDeps } from './logsExportCommand.js'

const NOW = new Date(2026, 10, 18, 10, 30)
const ZIP = 'harness-logs-20261118-1030.zip'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A throwaway home, working directory, log folders and menu-bar app log folder; nothing of this Mac's is read or run. */
function setup(args: string[], over: Partial<LogsExportDeps> = {}): { deps: LogsExportDeps; lines: string[]; root: string; home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'logs-export-'))
  roots.push(root)
  const home = join(root, 'home'), cwd = join(root, 'cwd'), logsDir = join(root, 'logs'), dataDir = join(root, 'data'), appLogs = join(root, 'app-logs')
  for (const dir of [home, cwd, logsDir, dataDir, appLogs]) mkdirSync(dir)
  writeFileSync(join(logsDir, 'app-20261118.log'), 'today\n')
  writeFileSync(join(logsDir, 'app-20261116.log'), 'two days ago\n')
  writeFileSync(join(appLogs, 'app-20261118.log'), 'menu-bar app\n')
  const lines: string[] = []
  const deps: LogsExportDeps = {
    args, logsDir, dataDir, version: '0.6.50', home, cwd, now: NOW, machineId: 'm_1',
    facts: async () => ({
      status: `$ harness status\nat ${home}/x for a@b.co\n`,
      versions: ['node: v24.22.2', 'Harness Device: 0.1.0'],
      deviceAppLogsDir: appLogs,
    }),
    out: (line) => lines.push(line),
    ...over,
  }
  return { deps, lines, root, home, cwd }
}

describe('logsExportCommand', () => {
  it('--json prints one line: path, included, bytes', async () => {
    const { deps, lines, root } = setup([])
    const to = join(root, 'to')
    deps.args = ['export', '--to', to, '--json']
    await logsExportCommand(deps)
    expect(lines).toHaveLength(1)
    const answer = JSON.parse(lines[0]) as { path: string; included: string[]; bytes: number }
    expect(Object.keys(answer).sort()).toEqual(['bytes', 'included', 'path'])
    expect(answer.path).toBe(join(to, ZIP))
    expect(statSync(answer.path).size).toBe(answer.bytes)
  })

  it('the zip holds the facts', async () => {
    const { deps, root } = setup([])
    deps.args = ['export', '--to', root, '--json']
    await logsExportCommand(deps)
    const files = readZip(readFileSync(join(root, ZIP)))
    expect(files.get('status.txt')?.toString()).toBe('$ harness status\nat ~/x for <email>\n')
    expect(files.get('logs/harness-device/app-20261118.log')?.toString()).toBe('menu-bar app\n')
    const readme = files.get('README.txt')!.toString()
    expect(readme).toContain('machine: m_1')
    expect(readme).toContain('node: v24.22.2')
    expect(readme).toContain('Harness Device: 0.1.0')
  })

  it('signed out, the README says so', async () => {
    const { deps, root } = setup([], { machineId: undefined })
    deps.args = ['export', '--to', root, '--json']
    await logsExportCommand(deps)
    expect(readZip(readFileSync(join(root, ZIP))).get('README.txt')!.toString()).toContain('machine: not signed in')
  })

  it('without --to the zip goes to the Desktop, else the working directory', async () => {
    const withDesktop = setup(['export', '--json'])
    mkdirSync(join(withDesktop.home, 'Desktop'))
    await logsExportCommand(withDesktop.deps)
    expect(existsSync(join(withDesktop.home, 'Desktop', ZIP))).toBe(true)

    const without = setup(['export', '--json'])
    await logsExportCommand(without.deps)
    expect(existsSync(join(without.cwd, ZIP))).toBe(true)
  })

  it('a relative --to gives an absolute path', async () => {
    const { deps, lines, cwd } = setup(['export', '--to', 'out', '--json'])
    await logsExportCommand(deps)
    expect((JSON.parse(lines[0]) as { path: string }).path).toBe(join(cwd, 'out', ZIP))
    expect(existsSync(join(cwd, 'out', ZIP))).toBe(true)
  })

  it('without --json it says where, then what', async () => {
    const { deps, lines, root } = setup([])
    deps.args = ['export', '--to', root, '--days', '1']
    await logsExportCommand(deps)
    expect(lines[0]).toMatch(/^wrote .* KB\)$/)
    expect(lines.slice(1)).toContain('  app-20261118.log')
    expect(lines.slice(1)).toContain('  harness-device/app-20261118.log')
    expect(lines.slice(1)).toContain('  status.txt')
    expect(lines.slice(1)).not.toContain('  app-20261116.log')
  })

  it('without --json the zip is named from the home it was given', async () => {
    const { deps, lines, home } = setup(['export'])
    mkdirSync(join(home, 'Desktop'))
    await logsExportCommand(deps)
    expect(lines[0].startsWith(`wrote ${join('~', 'Desktop', ZIP)} (`)).toBe(true)
  })
})
