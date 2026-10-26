import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAutonomousDeviceCommand } from './command.js'
import { pickMachine, runAddonCommand } from './addonCommand.js'
vi.mock('../hookAuth.js', () => ({ readHookCredential: () => 'hook-test-credential' }))
afterEach(() => vi.restoreAllMocks())

const ok = (body: unknown) => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body)))
const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {})

describe('harness autonomous-device addon', () => {
  it('reads what devices published, for one device when named', async () => {
    const fetch = ok({ devices: [] }); quiet()
    expect(await runAutonomousDeviceCommand(['addon', 'state'], '/unused', 18473)).toBe(0)
    expect(String(fetch.mock.calls[0][0])).toBe('http://127.0.0.1:18473/api/autonomous-device/addon/state')
    expect(await runAutonomousDeviceCommand(['addon', 'state', '--device', 'a b'], '/unused', 18473)).toBe(0)
    expect(String(fetch.mock.calls[1][0])).toBe('http://127.0.0.1:18473/api/autonomous-device/addon/state?deviceId=a%20b')
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer hook-test-credential' } })
  })

  it('posts a proposal with what was given, a fresh key, and the add-on named by --addon', async () => {
    const fetch = ok({ proposal: { proposalId: 'p' } }); quiet()
    expect(await runAutonomousDeviceCommand(['addon', 'propose', '--act', 'light', '--holds-ms', '30000', '--why', 'evening', '--sure', '0.6',
      '--params', '{"colour":"warm","level":2}', '--note', 'A warm evening light.', '--addon', 'evening-glow', '--device', 'lamp'], '/unused', 18473)).toBe(0)
    expect(String(fetch.mock.calls[0][0])).toBe('http://127.0.0.1:18473/api/autonomous-device/addon/propose')
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body))
    expect(body).toEqual({ addon: 'evening-glow', act: 'light', holdsMs: 30000, idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/),
      why: 'evening', sure: 0.6, params: { colour: 'warm', level: 2 }, note: 'A warm evening light.', deviceId: 'lamp' })
  })

  it('names the add-on after the agent running the shell, and keeps a given key', async () => {
    const fetch = ok({ proposal: {} }); quiet()
    vi.stubEnv('CLAUDECODE', '1'); vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'abc-123')
    try {
      expect(await runAutonomousDeviceCommand(['addon', 'propose', '--act', 'mood', '--holds-ms', '5000', '--key', 'once'], '/unused', 18473)).toBe(0)
    } finally { vi.unstubAllEnvs() }
    // The engine and a short hash: the session's own id never reaches the device.
    const hash = createHash('sha256').update('claude-code:abc-123').digest('hex').slice(0, 12)
    const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body))
    expect(sent).toMatchObject({ addon: `claude-${hash}`, idempotencyKey: 'once' })
    expect(JSON.stringify(sent)).not.toContain('abc-123')
  })

  it('says the key a failed propose used, for a retry that sends it at most once', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'OUTCOME_UNKNOWN', message: 'maybe' } }), { status: 504 }))
    const log = quiet()
    expect(await runAutonomousDeviceCommand(['addon', 'propose', '--act', 'mood', '--holds-ms', '5000', '--addon', 'x', '--key', 'k7', '--json'], '/unused', 18473)).toBe(1)
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ error: { code: 'OUTCOME_UNKNOWN', message: 'maybe' }, idempotencyKey: 'k7' })
  })

  it('reads one proposal back', async () => {
    const fetch = ok({ proposal: null }); quiet()
    const id = '0b6c3c3e-8f3a-4f5a-9d2b-6f1e2a3b4c5d'
    expect(await runAutonomousDeviceCommand(['addon', 'proposal', id, '--json'], '/unused', 18473)).toBe(0)
    expect(String(fetch.mock.calls[0][0])).toBe(`http://127.0.0.1:18473/api/autonomous-device/addon/proposal?proposalId=${id}`)
  })

  it('refuses before asking the daemon: no act, bad JSON, unknown flag, no add-on name, a flag the verb does not take', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); quiet()
    vi.stubEnv('CLAUDECODE', ''); vi.stubEnv('CLAUDE_CODE_SESSION_ID', ''); vi.stubEnv('CODEX_THREAD_ID', ''); vi.stubEnv('AI_AGENT', '')
    try {
      for (const argv of [
        ['addon'], ['addon', 'propose', '--holds-ms', '5000', '--addon', 'x'],
        ['addon', 'propose', '--act', 'light', '--holds-ms', '5000', '--addon', 'x', '--params', '{nope'],
        ['addon', 'propose', '--act', 'light', '--holds-ms', '5000', '--addon', 'x', '--force'],
        ['addon', 'propose', '--act', 'light', '--holds-ms', '5000'],
        ['addon', 'state', '--act', 'light'], ['addon', 'proposal'], ['addon', 'state', 'extra'],
        ...['', '0x1', '1e0', '1.5', '-0.1', 'nan'].map(sure => ['addon', 'propose', '--act', 'light', '--holds-ms', '5000', '--addon', 'x', '--sure', sure]),
        ...['', '5e3', '5000.5', '-5000'].map(holds => ['addon', 'propose', '--act', 'light', '--holds-ms', holds, '--addon', 'x']),
      ]) expect(await runAutonomousDeviceCommand(argv, '/unused', 18473)).toBe(1)
    } finally { vi.unstubAllEnvs() }
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('harness autonomous-device addon --machine', () => {
  it('asks the named machine over its link, with the same proposal, and says the key when it fails', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); const log = quiet()
    const asked: Array<[string, string, Record<string, unknown>]> = []
    const ask = async (machine: string, op: string, input: Record<string, unknown>) => {
      asked.push([machine, op, input])
      return op === 'propose' ? { error: { code: 'MACHINE_REQUIRED', message: 'no machine' } } : { result: { devices: [] } }
    }
    expect(await runAddonCommand(['state', '--machine', 'lamp-4ace'], '/unused', 18473, {}, ask)).toBe(0)
    expect(await runAddonCommand(['proposal', 'p1', '--machine', 'lamp-4ace'], '/unused', 18473, {}, ask)).toBe(0)
    expect(await runAddonCommand(['propose', '--machine', 'lamp-4ace', '--act', 'say', '--holds-ms', '30000', '--note', 'hi', '--addon', 'slack', '--key', 'k1'], '/unused', 18473, {}, ask)).toBe(1)
    expect(asked).toEqual([['lamp-4ace', 'state', {}], ['lamp-4ace', 'proposal', { proposalId: 'p1' }],
      ['lamp-4ace', 'propose', { addon: 'slack', act: 'say', holdsMs: 30000, idempotencyKey: 'k1', note: 'hi' }]])
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ error: { code: 'MACHINE_REQUIRED', message: 'no machine' }, idempotencyKey: 'k1' })
    expect(await runAddonCommand(['state', '--machine', 'lamp', '--device', 'x'], '/unused', 18473, {}, ask)).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('the machine --machine names', () => {
  const rows = [{ machineId: 'm_lamp', name: 'lamp-4ace' }, { machineId: 'm_a', name: 'Office' }, { machineId: 'm_b', hostname: 'office' },
    { machineId: 'm_shared', name: 'kim', isShared: true }]
  it('is an id, or the one machine of that name, case-blind; this machine too, as its own row', () => {
    expect(pickMachine('m_lamp', rows)).toBe('m_lamp')
    expect(pickMachine('LAMP-4ACE', rows)).toBe('m_lamp')
    expect(pickMachine('m_b', rows)).toBe('m_b')
  })
  it('refuses two machines of one name, and a machine shared with this account', () => {
    expect(() => pickMachine('office', rows)).toThrow(expect.objectContaining({ code: 'AMBIGUOUS' }))
    expect(() => pickMachine('kim', rows)).toThrow(expect.objectContaining({ code: 'MACHINE_NOT_FOUND' }))
  })
})

