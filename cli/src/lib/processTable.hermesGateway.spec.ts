/**
 * Hermes 0.22+ runs every session in one shared gateway, which the first Hermes client starts, on Windows as its child.
 * Rows below are the ones measured on DESKTOP-0TFH0OJ, 2026-11-09 (Hermes 0.22.7), and on a Mac's launchd gateway.
 * Before: the gateway matched as `hermes_cli` and was recorded as the first harness's engine (pid 23704), and Harness's
 * own boot module (`hermes-boot.py`, lib/windows/hermesLaunch.ts) matched nothing, so a second Hermes pane was never
 * confirmed and sat on "Waiting to confirm the native engine process".
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import type { ProcessRow } from './processTable.js'

const BOOT_KEY = '7:4242'
vi.mock('./engineBin.js', async (original) => {
  const actual = await original<typeof import('./engineBin.js')>()
  return {
    ...actual,
    agentCommandOwnershipSnapshot: (): AgentCommandOwnershipSnapshot => {
      const snapshot = actual.agentCommandOwnershipSnapshot()
      const keys = new Map(snapshot.engineFileKeys)
      keys.set('hermes', new Set([BOOT_KEY]))
      return { ...snapshot, engineFileKeys: keys }
    },
  }
})

const { engineProcessMatch, hermesGatewayProcess, hermesGatewaysUnder, selectEngineProcess } = await import('./processTable.js')

const PYTHON = 'C:\\Users\\DELL\\AppData\\Local\\hermes\\tools\\python-3.14.9+20261021-win32-x64\\python.exe'
const BOOT = 'C:\\Users\\DELL\\AppData\\Local\\hermes\\bin\\hermes-boot.py'
const row = (pid: number, parentPid: number, argv: string[], extra: Partial<ProcessRow> = {}): ProcessRow => ({
  pid, parentPid, executable: argv[0]!.split('\\').pop()!, startMarker: `w:${pid}`,
  args: argv.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' '), nativeArgv: argv, ...extra,
})
const PTY_HOST = row(24088, 13744, ['C:\\Users\\DELL\\.harness\\runtime\\pty\\0.5.80\\harness-pty.exe', 'serve'])
const CLIENT = row(24240, 24088, [PYTHON, '-I', BOOT], { entrypointFileKey: BOOT_KEY })
const GATEWAY = row(23704, 24240, [PYTHON, '-m', 'hermes_cli.main', '--profile', 'default', 'gateway', 'run', '--quiet', '--idle-exit'])
const SECOND_CLIENT = row(24276, 24088, [PYTHON, '-I', BOOT], { entrypointFileKey: BOOT_KEY })

describe('Hermes\' shared gateway', () => {
  it.each([
    ['the Windows gateway a client started', GATEWAY],
    ['a Mac\'s launchd gateway', row(1008, 1, ['/Users/u/.hermes/hermes-agent/venv/bin/python', '-m', 'hermes_cli.main', 'gateway', 'run', '--external-supervisor'])],
    ['one started by name', row(9, 1, ['/usr/local/bin/hermes', 'gateway', 'run'])],
    ['a profile\'s, by its short flag', row(9, 1, ['python3', '-m', 'hermes_cli.main', '-p', 'work', 'gateway', 'run'])],
    ['a row with only its command line', { ...GATEWAY, nativeArgv: undefined }],
  ])('is %s', (_name, gateway) => {
    expect(hermesGatewayProcess(gateway)).toBe(true)
    expect(engineProcessMatch(gateway, 'hermes').score).toBe(0)
  })

  it.each([
    ['Harness\'s boot module in a pane', CLIENT],
    ['a chat', row(9, 1, ['/usr/local/bin/hermes', 'chat'])],
    ['a chat whose prompt is the word', row(9, 1, ['/usr/local/bin/hermes', 'chat', '-q', 'gateway'])],
    ['the module run another way', row(9, 1, ['python3', '-m', 'hermes_cli.main', 'chat'])],
    ['the stderr wrapper around a gateway', row(819, 1, ['python', '-m', 'hermes_cli.stderr_timestamp', '--error-log', 'x', '--', 'python', '-m', 'hermes_cli.main', 'gateway', 'run'])],
    ['another program\'s gateway', row(9, 1, ['/usr/bin/other', 'gateway', 'run'])],
  ])('is not %s', (_name, other) => {
    expect(hermesGatewayProcess(other)).toBe(false)
  })
})

describe('the Hermes in a Windows pane', () => {
  it('is Harness\'s boot module, by its file', () => {
    expect(engineProcessMatch(CLIENT, 'hermes')).toEqual({ score: 4, evidence: 'file-identity' })
  })

  it('is the boot module of the pane that started the gateway, never the gateway under it', () => {
    expect(selectEngineProcess([PTY_HOST, CLIENT, GATEWAY, SECOND_CLIENT], CLIENT.pid, 'hermes')?.pid).toBe(CLIENT.pid)
  })

  it('is the boot module of a pane with no gateway under it, which was never confirmed', () => {
    expect(selectEngineProcess([PTY_HOST, CLIENT, GATEWAY, SECOND_CLIENT], SECOND_CLIENT.pid, 'hermes')?.pid).toBe(SECOND_CLIENT.pid)
  })

  it('names the gateway under it, which an older build recorded in its place, and only under it', () => {
    const rows = [PTY_HOST, CLIENT, GATEWAY, SECOND_CLIENT]
    expect(hermesGatewaysUnder(rows, CLIENT)).toEqual([{ pid: GATEWAY.pid, executable: GATEWAY.executable, startMarker: GATEWAY.startMarker }])
    expect(hermesGatewaysUnder(rows, SECOND_CLIENT)).toEqual([])
    // A reused pid is another process: nothing is under it.
    expect(hermesGatewaysUnder(rows, { ...CLIENT, startMarker: 'w:1' })).toEqual([])
  })

  it('is nothing when only the gateway is there', () => {
    const orphan = { ...GATEWAY, parentPid: PTY_HOST.pid }
    expect(selectEngineProcess([PTY_HOST, orphan], orphan.pid, 'hermes')).toBeNull()
  })
})
