import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { CoreApi, SuperTabScreen } from '../core/api.js'
import { screen as claudeScreen } from '../engines/claude/screen.js'
import { screen as codexScreen } from '../engines/codex/screen.js'
import { fakeCore } from '../testing/fakeCore.js'
import { CONTINUE, LimitResume } from './limitResume.js'

const RESET = 1_000_000 + 30 * 60_000
const resume = { conversationId: 'g1', assignmentId: 'w1', lostAt: 5, at: new Date(RESET).toISOString() }
const row = (over: Record<string, unknown> = {}) => ({ tabId: 'tab', agent: { id: 'a1', harnessId: 'h1', machineId: 'm1' }, resume, ...over })
/** A screen as the engine draws it (fixtures/screens). */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), 'utf8')

function setup(options: { live?: string[]; reply?: () => { status: number; body: Record<string, unknown> }; screen?: () => SuperTabScreen; owns?: () => boolean } = {}) {
  let clock = 1_000_000
  const steps: string[] = []
  const backend: CoreApi['account']['backend'] = vi.fn(async (_method, _path, body) => {
    steps.push(`ask ${(body as { command: { type: string } }).command.type}`)
    return options.reply?.() ?? { status: 200, body: { success: true, data: { result: {} } } }
  })
  const core = fakeCore({
    account: { backend },
    agents: { byAgent: vi.fn((id: string) => (options.live ?? ['h1']).includes(id) ? { agentId: id } as never : undefined) },
    superTabs: { attention: vi.fn(), cards: vi.fn(), cardRecap: vi.fn(), shareObservers: vi.fn(), screen: vi.fn(async () => options.screen?.() ?? { ok: true as const, text: '❯ ', hold: null }),
      input: vi.fn(async (_harnessId: string, text: string) => { steps.push(`type ${text}`); return { ok: true as const } }) },
  })
  // The host's current assignment rows, read after the backend answered (host.ts reads its feed).
  const owns = vi.fn(async (tabId: string, assignmentId: string, harnessId: string) => { steps.push(`check ${tabId} ${assignmentId} ${harnessId}`); return options.owns?.() ?? true })
  const resumer = new LimitResume(core, 'm1', { now: () => clock, log: vi.fn(), owns })
  return { core, backend, steps, resumer, wait: (ms: number) => { clock += ms } }
}

describe('a host resuming a task its agent lost to a usage limit', () => {
  it('waits for the reset, then asks the backend to give the task back before typing continue into the same session', async () => {
    const t = setup()
    await t.resumer.tick([row()])
    expect(t.steps).toEqual([])
    t.wait(30 * 60_000)
    await t.resumer.tick([row()])
    expect(t.steps).toEqual(['ask work.resume', 'check tab w1 h1', `type ${CONTINUE}`])
    expect(t.backend).toHaveBeenCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'limit-resume-w1-5', asAgentId: 'a1',
      command: { type: 'work.resume', conversationId: 'g1', assignmentId: 'w1', lostAt: 5 } })
    expect(t.core.superTabs!.input).toHaveBeenCalledWith('h1', CONTINUE, ['Enter'])
  })

  it('never types into the session when the backend says the task was handed on first, and does not ask again', async () => {
    const t = setup({ reply: () => ({ status: 409, body: { success: false, error: { code: 'TASK_MOVED', message: 'This task was handed on or closed, so it does not resume.' } } }) })
    t.wait(30 * 60_000)
    await t.resumer.tick([row()])
    await t.resumer.tick([row()])
    expect(t.steps).toEqual(['ask work.resume'])
    expect(t.core.superTabs!.input).not.toHaveBeenCalled()
  })

  it('does not type when this session no longer holds the task though the backend said yes: a replayed yes after a takeover (#1757 review, 2)', async () => {
    const t = setup({ owns: () => false })
    t.wait(30 * 60_000)
    await t.resumer.tick([row()])
    t.wait(15_000)
    await t.resumer.tick([row()])
    expect(t.steps).toEqual(['ask work.resume', 'check tab w1 h1'])
    expect(t.core.superTabs!.input).not.toHaveBeenCalled()
  })

  it('asks again on a later read when the backend could not be reached or its clock has not reached the reset yet', async () => {
    const replies = [{ status: 503, body: { success: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'Down.' } } },
      { status: 409, body: { success: false, error: { code: 'LIMIT_NOT_RESET', message: 'Its usage limit has not reset yet.' } } }]
    const t = setup({ reply: () => replies.shift() ?? { status: 200, body: { success: true, data: { result: {} } } } })
    t.wait(30 * 60_000)
    for (let i = 0; i < 3; i++) {
      await t.resumer.tick([row()])
      await t.resumer.tick([row()])
      t.wait(15_000)
    }
    expect(t.steps).toEqual(['ask work.resume', 'ask work.resume', 'ask work.resume', 'check tab w1 h1', `type ${CONTINUE}`])
  })

  it('types continue once, though a roster read from before the resume still lists it', async () => {
    const t = setup()
    t.wait(30 * 60_000)
    await t.resumer.tick([row()])
    await t.resumer.tick([row()])
    expect(t.steps).toEqual(['ask work.resume', 'check tab w1 h1', `type ${CONTINUE}`])
  })

  it('resumes the same task again when it is lost to a limit a second time (#1757 review, 1)', async () => {
    const t = setup()
    t.wait(30 * 60_000)
    await t.resumer.tick([row()])
    t.wait(60 * 60_000)
    await t.resumer.tick([row({ resume: { ...resume, lostAt: 9, at: new Date(RESET + 30 * 60_000).toISOString() } })])
    expect(t.steps).toEqual(['ask work.resume', 'check tab w1 h1', `type ${CONTINUE}`, 'ask work.resume', 'check tab w1 h1', `type ${CONTINUE}`])
    expect(vi.mocked(t.backend).mock.calls.map(([, , body]) => (body as { operationId: string }).operationId)).toEqual(['limit-resume-w1-5', 'limit-resume-w1-9'])
  })

  it('leaves alone an agent of another machine, one not running here, one stopping, and one with nothing to resume', async () => {
    const t = setup({ live: ['h1', 'h3'] })
    t.wait(30 * 60_000)
    await t.resumer.tick([row({ agent: { id: 'a2', harnessId: 'h2', machineId: 'm2' } }), row({ agent: { id: 'a4', harnessId: 'h4', machineId: 'm1' } }),
      row({ agent: { id: 'a3', harnessId: 'h3', machineId: 'm1' }, stopRequested: true }), row({ resume: null }), { tabId: 'tab', cleanup: { machineId: 'm1', removalId: 'x' } }])
    expect(t.steps).toEqual([])
  })

  it('holds back the typing while a prompt or a menu is open, where Enter would choose something, and types once it is gone', async () => {
    let hold: SuperTabScreen = { ok: true, text: 'Allow edit? 1. Yes 2. No', hold: 'permission_open' }
    const t = setup({ screen: () => hold })
    t.wait(30 * 60_000)
    await t.resumer.tick([row()])
    expect(t.steps).toEqual(['ask work.resume', 'check tab w1 h1'])
    // The task is the agent's again, so its row no longer asks; the host still owes the typing.
    hold = { ok: false, error: 'Could not read the terminal.' }
    t.wait(15_000)
    await t.resumer.tick([row({ resume: null })])
    hold = { ok: true, text: '❯ ', hold: null }
    await t.resumer.tick([row({ resume: null })])
    expect(t.steps).toEqual(['ask work.resume', 'check tab w1 h1', 'check tab w1 h1'])
    t.wait(15_000)
    await t.resumer.tick([row({ resume: null })])
    expect(t.steps).toEqual(['ask work.resume', 'check tab w1 h1', 'check tab w1 h1', 'check tab w1 h1', `type ${CONTINUE}`])
  })

  it('reads the screen when it types: a prompt that opens while the backend answers gets no continue (#1757 review, 3)', async () => {
    let screen: SuperTabScreen = { ok: true, text: '❯ ', hold: null }
    const t = setup({ screen: () => screen, reply: () => {
      screen = { ok: true, text: 'Allow edit? 1. Yes 2. No', hold: 'permission_open' }
      return { status: 200, body: { success: true, data: { result: {} } } }
    } })
    t.wait(30 * 60_000)
    await t.resumer.tick([row()])
    expect(t.steps).toEqual(['ask work.resume', 'check tab w1 h1'])
    expect(t.core.superTabs!.input).not.toHaveBeenCalled()
  })

  it('drops typing it still owes once the task is no longer this session\'s', async () => {
    let owns = true
    const t = setup({ screen: () => ({ ok: true, text: 'Allow edit? 1. Yes 2. No', hold: 'permission_open' }), owns: () => owns })
    t.wait(30 * 60_000)
    await t.resumer.tick([row()])
    owns = false
    t.wait(15_000)
    await t.resumer.tick([])
    t.wait(15_000)
    await t.resumer.tick([])
    expect(t.steps).toEqual(['ask work.resume', 'check tab w1 h1', 'check tab w1 h1'])
  })

  // Nothing redraws when a limit resets: the screen its host reads then is the limit screen the engine left (Lead,
  // 2026-10-27: prove continue goes into each engine). Codex marks its composer in bold only, so a plain read of it says
  // the prompt is hidden; that is no prompt or menu Enter would answer.
  it.each([['claude-session-limit', claudeScreen], ['claude-weekly-limit', claudeScreen], ['claude-opus-limit', claudeScreen],
    ['claude-fable-limit', claudeScreen], ['codex-usage-limit', codexScreen], ['codex-model-limit', codexScreen]] as const)(
    'types continue into the %s screen as its engine reads it after the reset', async (name, engine) => {
      const text = fixture(name)
      const t = setup({ screen: () => ({ ok: true, text, hold: engine.inspect(text).messageHold }) })
      t.wait(30 * 60_000)
      await t.resumer.tick([row()])
      expect(t.steps).toEqual(['ask work.resume', 'check tab w1 h1', `type ${CONTINUE}`])
    })
})
