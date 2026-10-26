import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendNotice, TurnDelivery } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { PaneInbox } from './inbox.js'
import { deliveryKey, FYI_REASON, MAX_BACKOFF_MS, PUMP_MS } from './mailbox.js'
import { header, LEADER_ROLE, LIMITS, LONG_TEXT, longAdvice, MessageError, parseMessage, RULES, WORKER_ROLE, type Message } from './model.js'
import type { Rpc } from './rpc.js'
import { HELD_OFF_REASON, HELD_OUTSIDE_MS, MESSAGES_OFF_TEXT, REMOTE_STATUS_MS, SETTING_FRESH_MS, startAgentMessages, SWEEP_AFTER_MS, TICK_MS, WHO_MS } from './service.js'
import { MessageStore } from './store.js'
import { Ledger, ledgerPath } from '../agentClient/ledger.js'
import { agentSettingsPath } from '../lib/agentSettings.js'
import { setAgentSettingsForTest, signedOutForTest } from '../testing/agentSettings.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-messages-'))
  // The account has turned Agent Messages on: off by default (lib/agentSettings.ts), and these are about what they do
  // once on. A test of the default removes the file.
  setAgentSettingsForTest(root, { agentMessages: true })
})
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); signedOutForTest() })

const OWNER_LOCAL = { local: true, owner: true }
const OWNER_REMOTE = { local: false, owner: true }
const session = (agentId: string, pane: string, engine = 'claude', cwd = `/work/${agentId}`) =>
  ({ agentId, sessionId: `s-${agentId}`, engine, cwd, tmuxPane: pane, runtimes: [{ backend: 'tmux', paneId: pane }], active: true, title: agentId }) as unknown as RegisteredSession
/** A harness in a pty host pane: its `tmuxPane` is that pane's id, which a tmux pane may also have. */
const ptySession = (agentId: string, pane: string, engine = 'claude', instance = 'p1') =>
  ({ ...session(agentId, pane, engine), runtimes: [{ backend: 'ptyhost', instance, paneId: pane }] }) as unknown as RegisteredSession

interface Setup {
  tabs?: Array<{ id: string; name: string; panes: Array<{ machineId: string; agentId: string }>; leader?: { machineId: string; agentId: string } | null }>
  agents?: RegisteredSession[]
  rpc?: Rpc
  backendStatus?: number
  signedIn?: () => boolean
}

function setup(over: Setup = {}) {
  let clock = 1_000_000
  const agents = over.agents ?? [session('lead', '%1', 'codex'), session('api', '%2'), session('web', '%3')]
  const tabs = over.tabs ?? [{ id: 'app', name: 'app', panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'api' }, { machineId: 'm2', agentId: 'phone' }] }]
  const directory = { revision: 4, machines: [{ machineId: 'm1', name: 'studio' }, { machineId: 'm2', name: 'laptop' }], tabs }
  const delivered: Array<[string, string, string]> = []
  const windows: Array<Record<string, unknown>> = []
  const deliveryListeners = new Set<(event: TurnDelivery) => void>()
  const noticeListeners = new Set<(notice: BackendNotice) => void>()
  const backend = vi.fn(async (_method: string, _path: string, _body?: unknown) => ({ status: over.backendStatus ?? 200, body: { success: true, data: directory } }))
  const rpcCalls: Array<[string, Record<string, unknown>]> = []
  const rpc: Rpc = over.rpc ?? (async (target, payload) => {
    rpcCalls.push([target.machineId, payload])
    if (payload.action === 'who') return { agents: [{ agentId: 'phone', name: 'phone', engine: 'claude', project: 'app' }] }
    if (payload.action === 'deliver') return { statuses: [{ messageId: (payload.message as { id: string }).id, agentId: 'phone', state: 'queued' }] }
    return { statuses: [] }
  })
  const changed = vi.fn()
  /** The watches on the setting's file, armed while Agent Messages are off (settingWatch.ts): heard at a write. */
  const watchers = new Set<() => void>()
  const core = fakeCore({
    dataDir: root,
    daemon: { machineId: () => 'm1', port: 18473 },
    agents: {
      live: () => agents,
      displayName: (s) => (s as unknown as { title: string }).title,
      terminalAvailable: () => true,
    },
    turns: {
      deliver: (agentId, text, id) => { delivered.push([agentId, text, id]) },
      onDelivery: (listener) => { deliveryListeners.add(listener); return () => deliveryListeners.delete(listener) },
    },
    account: {
      backend,
      onNotice: (listener) => { noticeListeners.add(listener); return () => noticeListeners.delete(listener) },
      ...(over.signedIn ? { signedIn: over.signedIn } : {}),
    },
    clients: { windows: (frame) => { windows.push(frame) } },
  })
  const service = startAgentMessages(core, { stateDir: join(root, 'state'), inboxRoot: join(root, 'inbox-root'), rpc: over.rpc ? over.rpc : rpc, now: () => clock, changed,
    watchSetting: (_path, heard) => { watchers.add(heard); return () => { watchers.delete(heard) } } })
  const ask = (payload: Record<string, unknown>, asker = OWNER_LOCAL) => service.requests.agent_messages!(payload, asker)
  return {
    service, ask, delivered, windows, backend, rpcCalls, agents, tabs, directory, changed, watchers,
    inbox: new PaneInbox(join(root, 'inbox-root')),
    tick: (ms: number) => { clock += ms },
    /** The account's switch as this computer keeps it, as the person turns Agent Messages on or off: read at the
     *  service's next look, once what it read last is no longer fresh, and heard by the watch on its file while off. */
    setting: (on: boolean) => {
      setAgentSettingsForTest(root, { agentMessages: on })
      clock += SETTING_FRESH_MS
      for (const heard of [...watchers]) heard()
    },
    deliveryEvent: (event: TurnDelivery) => { for (const l of deliveryListeners) l(event) },
    notice: (notice: BackendNotice) => { for (const l of noticeListeners) l(notice) },
  }
}

describe('harness send', () => {
  it('sends from the pane\'s harness to a teammate on this machine, typed into it when idle, with the roster note first', async () => {
    const t = setup()
    const reply = await t.ask({ action: 'send', pane: '%1', to: ['api'], text: 'Is the cleanup fix in?' })
    expect(reply).toMatchObject({ tab: 'app', recipients: [{ name: 'api', state: 'queued' }] })
    const id = reply.id as string
    expect(id).toMatch(/^m[0-9a-z]{7}$/)
    expect(t.delivered).toHaveLength(1)
    const [agentId, text, deliveryId] = t.delivered[0]
    expect(agentId).toBe('api')
    expect(deliveryId).toBe(`team:msg:${deliveryKey(id, 'api')}:1`)
    expect(text).toContain('[Harness] Agent Messages are on in tab "app". Teammates:')
    expect(text).toContain('lead')
    expect(text).toContain('phone')
    expect(text).toContain(`[${id} from lead · Codex · studio]\nIs the cleanup fix in?`)
    expect(t.service.canWrite(deliveryId)).toBe(true)
    // The core typed it: delivered, and the windows hear of it.
    t.deliveryEvent({ deliveryId, sessionId: 'api', state: 'started' })
    const history = await t.ask({ action: 'history', tabId: 'app' })
    expect(history.messages).toEqual([expect.objectContaining({ id, statuses: expect.arrayContaining([
      expect.objectContaining({ machineId: 'm1', agentId: 'api', state: 'delivered', via: 'prompt' }),
    ]) })])
    expect(t.windows.at(-1)).toMatchObject({ type: 'messages_changed', payload: { tabId: 'app', messageId: id, to: [{ agentId: 'api', state: 'delivered' }] } })
    // The note rode with the message: the next one comes without it.
    const second = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'thanks' })
    expect(t.delivered.at(-1)![1]).toBe(`[${second.id} from lead · Codex · studio]\nthanks`)
  })

  it('hands a teammate on another machine to that machine, and asks later what became of it', async () => {
    const t = setup()
    const reply = await t.ask({ action: 'send', pane: '%1', to: ['phone'], text: 'ping' })
    expect(reply.recipients).toEqual([{ name: 'phone', state: 'queued' }])
    expect(t.rpcCalls.map(([machine, p]) => [machine, p.action])).toEqual([['m2', 'who'], ['m2', 'deliver']])
    expect(t.rpcCalls[1][1].message).toMatchObject({ id: reply.id, from: { agentId: 'lead', machine: 'studio' }, to: [{ machineId: 'm2', agentId: 'phone', name: 'phone' }] })
    t.tick(REMOTE_STATUS_MS)
  })

  it('without a recipient lists who is here; and says plainly what is wrong with a send', async () => {
    const t = setup()
    const roster = await t.ask({ action: 'send', pane: '%1' })
    expect(roster.roster).toContain('Teammates:')
    expect(roster.roster).toMatch(/api\s+Claude Code · studio · api/)
    expect(roster.roster).toMatch(/phone\s+Claude Code · laptop · app/)
    // A tab no other account shares: the note as it was before shared tabs, to the byte (no account, branch or GitHub lines).
    expect(roster.roster).toBe(['[Harness] Agent Messages are on in tab "app". Teammates:', '  api    Claude Code · studio · api', '  phone  Claude Code · laptop · app', RULES].join('\n'))
    const fail = async (payload: Record<string, unknown>, asker = OWNER_LOCAL) => (await t.ask(payload, asker)).error
    expect(await fail({ action: 'send', pane: 'nope', to: 'api', text: 'x' })).toBe('NOT_A_HARNESS')
    expect(await fail({ action: 'send', pane: '%99', to: 'api', text: 'x' })).toBe('NOT_A_HARNESS')
    expect(await fail({ action: 'send', pane: '%1', text: 'x' })).toBe('USAGE')
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: '  ' })).toBe('USAGE')
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: 'x'.repeat(LIMITS.text + 1) })).toBe('TOO_LONG')
    expect(await fail({ action: 'send', pane: '%1', to: 'nobody', text: 'x' })).toBe('UNKNOWN_RECIPIENT')
    // A unique start of a name is enough.
    expect((await t.ask({ action: 'send', pane: '%1', to: 'ph', text: 'x' })).recipients).toEqual([{ name: 'phone', state: 'queued' }])
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: 'x' }, OWNER_REMOTE)).toBe('LOCAL_ONLY')
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: 'x' }, { local: true, owner: false })).toBe('OWNER_REQUIRED')
    expect(await fail({ action: 'nonsense' })).toBe('UNKNOWN_ACTION')
    // Sent to the same teammate twice in one message: once.
    const twice = await t.ask({ action: 'send', pane: '%1', to: 'api,API', text: 'once' })
    expect(twice.recipients).toHaveLength(1)
    // Its last messages come back with the roster, as the sender and as the recipient see them.
    const lead = await t.ask({ action: 'send', pane: '%1' })
    expect((lead.recent as Array<Record<string, unknown>>).at(-1)).toMatchObject({ id: twice.id, to: ['api'], text: 'once', state: 'queued' })
    const api = await t.ask({ action: 'send', pane: '%2' })
    expect((api.recent as Array<Record<string, unknown>>).at(-1)).toMatchObject({ id: twice.id, from: 'lead', state: 'queued' })
  })

  it('gives an agent that reads its messages itself every one still waiting, whole and once, then its last few', async () => {
    // A Codex lead running since before Agent Messages never ran the hook and, always working, was never typed to: it
    // read `harness send` alone, which gave only its last five, each still "queued" (2026-10-12).
    const t = setup()
    const ids: string[] = []
    for (let i = 1; i <= 7; i++) {
      const sent = await t.ask({ action: 'send', pane: '%1', to: 'api', text: `finding ${i}\nwith its details` })
      ids.push(String(sent.id))
      // api is working: each typed attempt goes back to the hook, which never runs.
      t.deliveryEvent({ deliveryId: t.delivered.at(-1)![2], sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    }
    const first = (await t.ask({ action: 'send', pane: '%2' })).recent as Array<Record<string, unknown>>
    const unread = first.filter((m) => m.unread === true)
    expect(unread.map((m) => m.id)).toEqual(ids)
    expect(unread.every((m) => m.state === 'delivered' && m.text === `finding ${ids.indexOf(String(m.id)) + 1}\nwith its details`)).toBe(true)
    const history = await t.ask({ action: 'history', tabId: 'app' }) as { messages: Array<{ statuses: Array<Record<string, unknown>> }> }
    expect(history.messages.flatMap((m) => m.statuses).filter((s) => s.agentId === 'api').every((s) => s.state === 'delivered' && s.via === 'read')).toBe(true)
    // Read once: the next look gives nothing new, and its last five as before.
    const again = (await t.ask({ action: 'send', pane: '%2' })).recent as Array<Record<string, unknown>>
    expect(again.filter((m) => m.unread)).toEqual([])
    expect(again.map((m) => m.id)).toEqual(ids.slice(-5))
    // The sender sees them delivered.
    const lead = (await t.ask({ action: 'send', pane: '%1' })).recent as Array<Record<string, unknown>>
    expect(lead.every((m) => m.state === 'delivered')).toBe(true)
  })

  it('sends news that never starts a turn of an idle teammate, marked as news where it is read', async () => {
    const t = setup()
    const sent = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'quiet window 04:19–04:22Z', fyi: true })
    expect(sent.recipients).toEqual([{ name: 'api', state: 'queued', reason: FYI_REASON }])
    expect(t.delivered).toEqual([])
    const read = (await t.ask({ action: 'send', pane: '%2' })).recent as Array<Record<string, unknown>>
    expect(read.find((m) => m.id === sent.id)).toMatchObject({ unread: true, state: 'delivered', text: 'quiet window 04:19–04:22Z' })
    const history = await t.ask({ action: 'history', tabId: 'app' }) as { messages: Array<Record<string, unknown>> }
    expect(history.messages.find((m) => m.id === sent.id)).toMatchObject({ fyi: true })
    expect(header({ ...(history.messages[0] as unknown as Message), fyi: true })).toMatch(/ · FYI\]$/)
    expect(header({ ...(history.messages[0] as unknown as Message), fyi: undefined })).not.toMatch(/FYI/)
    // Only `true` is news on the wire.
    expect(parseMessage({ ...history.messages[0], fyi: 'yes' })).not.toHaveProperty('fyi')
  })

  it('sends a long message, and tells its sender what it costs the teammates who read it', async () => {
    const t = setup()
    expect(await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x'.repeat(LONG_TEXT) })).not.toHaveProperty('advice')
    const long = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x'.repeat(LONG_TEXT + 1) })
    expect(long.recipients).toHaveLength(1)
    expect(long.advice).toBe(longAdvice(LONG_TEXT + 1))
    expect(long.advice).toMatch(/leave the rest in the repo/)
  })

  it('tells two teammates with the same start apart only by more of the name', async () => {
    const t = setup({
      agents: [session('lead', '%1'), session('api-a', '%2'), session('api-b', '%3')],
      tabs: [{ id: 'app', name: 'app', panes: ['lead', 'api-a', 'api-b'].map((agentId) => ({ machineId: 'm1', agentId })) }],
    })
    expect((await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).error).toBe('AMBIGUOUS_RECIPIENT')
    expect((await t.ask({ action: 'send', pane: '%1', to: 'api-b', text: 'x' })).recipients).toEqual([{ name: 'api-b', state: 'queued' }])
  })

  it('tells apart teammates that share a title, the sender included, by the start of their ids', async () => {
    // Two Codex agents titled themselves after the same task, and the roster named the teammate as the agent itself
    // (a fresh Mac, 2026-10-12).
    const titled = (agentId: string, pane: string) => ({ ...session(agentId, pane, 'codex'), title: 'Ask teammate to create notes' }) as unknown as RegisteredSession
    const t = setup({
      agents: [titled('efedc3c7-lead', '%1'), titled('07934321-one', '%2'), titled('11112222-two', '%3')],
      tabs: [{ id: 'app', name: 'app', panes: ['efedc3c7-lead', '07934321-one', '11112222-two'].map((agentId) => ({ machineId: 'm1', agentId })) }],
    })
    const roster = String((await t.ask({ action: 'send', pane: '%1' })).roster)
    expect(roster).toContain('Ask teammate to create notes (07934321)')
    expect(roster).toContain('Ask teammate to create notes (11112222)')
    expect((await t.ask({ action: 'send', pane: '%1', to: 'Ask teammate to create notes', text: 'x' })).error).toBe('AMBIGUOUS_RECIPIENT')
    expect((await t.ask({ action: 'send', pane: '%1', to: 'Ask teammate to create notes (07934321)', text: 'x' })).recipients)
      .toEqual([{ name: 'Ask teammate to create notes (07934321)', state: 'queued' }])
    expect((await t.ask({ action: 'send', pane: '%1', to: '11112222', text: 'x' })).recipients)
      .toEqual([{ name: 'Ask teammate to create notes (11112222)', state: 'queued' }])
    // Its header names the sender as its teammates' roster does, so a reply finds it.
    const history = await t.ask({ action: 'history' }) as { messages: Array<{ from: { name: string } }> }
    expect(history.messages.map((m) => m.from.name)).toEqual(['Ask teammate to create notes (efedc3c7)', 'Ask teammate to create notes (efedc3c7)'])
    // A title no one else has stays as it is.
    const plain = setup()
    expect(String((await plain.ask({ action: 'send', pane: '%1' })).roster)).toMatch(/^ {2}api {2}/m)
  })

  it('takes the whole name of a teammate whose engine cut its title short', async () => {
    // Codex titles its terminal with the folder cut to fit; an agent wrote the folder out and was told no one had
    // that name (a fresh Mac, 2026-10-12).
    const t = setup({
      agents: [session('lead', '%1'), { ...session('cx', '%2', 'codex'), title: 'claude-code-2026-10-1...' } as unknown as RegisteredSession,
        { ...session('dots', '%3', 'codex'), title: '...' } as unknown as RegisteredSession],
      tabs: [{ id: 'app', name: 'app', panes: ['lead', 'cx', 'dots'].map((agentId) => ({ machineId: 'm1', agentId })) }],
    })
    expect((await t.ask({ action: 'send', pane: '%1', to: 'claude-code-2026-10-12-02-15', text: 'x' })).recipients)
      .toEqual([{ name: 'claude-code-2026-10-1...', state: 'queued' }])
    expect((await t.ask({ action: 'send', pane: '%1', to: 'claude-code-2026-10-1…', text: 'x' })).recipients)
      .toEqual([{ name: 'claude-code-2026-10-1...', state: 'queued' }])
    // A title that is nothing but an ellipsis is no stem for every name.
    expect((await t.ask({ action: 'send', pane: '%1', to: 'zzz', text: 'x' })).error).toBe('UNKNOWN_RECIPIENT')
  })

  it('names in the note only a tab the person named; the windows label any other themselves', async () => {
    // The note said tab "New Tab" for a tab the window showed as "code" (a fresh Mac, 2026-10-12).
    const pair = [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'api' }]
    const roster = async (tabs: Array<Record<string, unknown>>) =>
      String((await setup({ tabs: tabs as unknown as Setup['tabs'] }).ask({ action: 'send', pane: '%1' })).roster).split('\n')[0]
    expect(await roster([{ id: 'a', name: 'claude-code-2026-10-12-02-15', named: false, panes: pair }]))
      .toBe('[Harness] Agent Messages are on in this tab. Teammates:')
    expect(await roster([{ id: 'a', name: 'app', named: true, panes: pair }])).toBe('[Harness] Agent Messages are on in tab "app". Teammates:')
    expect(await roster([{ id: 'a', name: 'app', named: true, panes: pair }, { id: 'b', name: 'web', named: true, panes: pair }]))
      .toBe('[Harness] Agent Messages are on in tabs "app", "web". Teammates:')
    expect(await roster([{ id: 'a', name: 'app', named: true, panes: pair }, { id: 'b', name: 'New Tab', named: false, panes: pair }]))
      .toBe('[Harness] Agent Messages are on in tab "app" and this one. Teammates:')
    // A backend from before `named`: only the window's own default name is no name.
    expect(await roster([{ id: 'a', name: 'New Tab', panes: pair }])).toBe('[Harness] Agent Messages are on in this tab. Teammates:')
    expect(await roster([{ id: 'a', name: 'app', panes: pair }])).toBe('[Harness] Agent Messages are on in tab "app". Teammates:')
  })

  it('refuses while Agent Messages are off on this computer, saying where to turn them on, and when the directory cannot be read', async () => {
    // One switch of the account replaced each tab's chat icon, which the owner hit by mistake (2026-10-12).
    const refused = { error: 'MESSAGES_OFF', detail: 'Agent Messages are off. The person turns on "Agents in the same tab can message each other" in Settings ▸ Experimental, or runs `harness settings agent-messages on`.' }
    // An account that never said: off by default, so nothing is sent and no one is told of teammates.
    rmSync(agentSettingsPath(root))
    const fresh = setup()
    expect(await fresh.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toEqual(refused)
    expect(await fresh.ask({ action: 'send', pane: '%1' })).toEqual(refused)
    expect(fresh.delivered).toEqual([])
    const off = setup()
    off.setting(true)
    off.setting(false)
    expect(await off.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toEqual(refused)
    expect(MESSAGES_OFF_TEXT).toBe(refused.detail)
    // Nor does `harness send` alone list anyone.
    expect(await off.ask({ action: 'send', pane: '%1' })).toEqual(refused)
    expect(off.delivered).toEqual([])
    // Off is the person's word: said so even when the tabs cannot be read.
    const offAndDown = setup({ backendStatus: 500 })
    expect(await offAndDown.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toEqual(refused)
    // On again: it sends at the next look.
    off.setting(true)
    expect((await off.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).recipients).toEqual([{ name: 'api', state: 'queued' }])
    const down = setup({ backendStatus: 500 })
    expect(await down.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toMatchObject({ error: 'DIRECTORY_UNAVAILABLE' })
  })

  it('says a harness alone in its tab, or in none, has no teammates, and still lists its last messages', async () => {
    const alone = setup({ tabs: [{ id: 'app', name: 'app', panes: [{ machineId: 'm1', agentId: 'lead' }] }, { id: 'web', name: 'web', panes: [{ machineId: 'm1', agentId: 'api' }] }] })
    const none = { error: 'NO_TEAMMATES', detail: 'No other harness is in this tab. The person puts harnesses in one tab for them to message each other.' }
    expect(await alone.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toEqual(none)
    expect(await alone.ask({ action: 'send', pane: '%1', text: 'x' })).toEqual(none)
    // web is in no tab at all.
    expect(await alone.ask({ action: 'send', pane: '%3', to: 'lead', text: 'x' })).toEqual(none)
    expect(await alone.ask({ action: 'send', pane: '%1' })).toEqual({ roster: 'No teammates in this tab yet.', recent: [] })
    expect(await alone.ask({ action: 'send', pane: '%3' })).toEqual({ roster: 'No teammates in this tab yet.', recent: [] })
    expect(alone.delivered).toEqual([])
  })

  /** A send that asks another machine for names, with [meanwhile] done while that machine is asked: the directory is
   *  read and every name learned first, then the names grow old, so only the send asks again. */
  const whileAsking = async (meanwhile: (t: ReturnType<typeof setup>) => Promise<void> | void) => {
    let t: ReturnType<typeof setup>
    let armed = false
    t = setup({ rpc: async (_target, payload) => {
      if (payload.action === 'who') {
        if (armed) await meanwhile(t)
        return { agents: [{ agentId: 'phone', name: 'phone', engine: 'claude' }] }
      }
      return { statuses: [] }
    } })
    expect(String((await t.ask({ action: 'send', pane: '%1' })).roster)).toContain('phone')
    t.tick(WHO_MS)
    armed = true
    return t
  }

  it('sends nothing when Agent Messages are turned off while it asks another machine for names', async () => {
    const t = await whileAsking((t) => t.setting(false))
    expect(await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toEqual({ error: 'MESSAGES_OFF', detail: `${MESSAGES_OFF_TEXT} Nothing was sent.` })
    expect(t.delivered).toEqual([])
    expect((await t.ask({ action: 'history' })).messages).toEqual([])
  })

  it('sends nothing when the teammate leaves the tab while it asks another machine for names', async () => {
    const t = await whileAsking(async (t) => {
      t.tabs[0].panes = t.tabs[0].panes.filter((p) => p.agentId !== 'api')
      t.notice({ type: 'desk_changed', revision: 5 })
      await new Promise((settle) => setTimeout(settle, 0))
    })
    expect(await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toEqual({ error: 'NOT_IN_TAB', detail: 'api is no longer in a tab with you. Nothing was sent.' })
    expect(t.delivered).toEqual([])
    expect((await t.ask({ action: 'history' })).messages).toEqual([])
  })

  it('limits how often one harness sends, and tells the windows', async () => {
    const t = setup()
    for (let i = 0; i < LIMITS.perSender; i++) await t.ask({ action: 'send', pane: '%1', to: 'api', text: `n${i}` })
    expect(await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'one more' })).toMatchObject({ error: 'RATE_LIMITED' })
    expect(t.windows.some((w) => (w.payload as Record<string, unknown>).limited)).toBe(true)
    t.tick(LIMITS.window)
    expect((await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'later' })).recipients).toBeDefined()
  })

  it('keeps a message for a machine that is away, and hands it over once it is back', async () => {
    vi.useFakeTimers()
    let away = true
    const calls: string[] = []
    const t = setup({ rpc: async (target, payload) => {
      calls.push(String(payload.action))
      if (payload.action === 'who') return { agents: [{ agentId: 'phone', name: 'phone', engine: 'claude' }] }
      if (away) throw new MessageError(payload.action === 'deliver' && calls.length > 4 ? 'NO_PEER_LINK' : 'DISCONNECTED', 'away')
      if (payload.action === 'deliver') return { statuses: [{ messageId: (payload.message as { id: string }).id, agentId: 'phone', state: 'delivered', via: 'hook' }] }
      return { statuses: [] }
    } })
    t.service.start()
    const reply = await t.ask({ action: 'send', pane: '%1', to: 'phone', text: 'when you are back' })
    expect(reply.recipients).toEqual([{ name: 'phone', state: 'queued', reason: 'that machine is away: it is handed over once it is back' }])
    away = false
    t.tick(60_000)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const history = await t.ask({ action: 'history' })
    expect((history.messages as Array<{ statuses: unknown[] }>)[0].statuses).toEqual([expect.objectContaining({ machineId: 'm2', agentId: 'phone', state: 'delivered', via: 'hook' })])
    t.service.stop()
  })

  it('keeps how another machine\'s agent got a message, read with `harness send` too, and nothing else', async () => {
    vi.useFakeTimers()
    let via: unknown = 'read'
    const t = setup({ rpc: async (target, payload) => {
      if (payload.action === 'who') return { agents: [{ agentId: 'phone', name: 'phone', engine: 'claude' }] }
      if (payload.action === 'deliver') return { statuses: [{ messageId: (payload.message as { id: string }).id, agentId: 'phone', state: 'queued' }] }
      return { statuses: (payload.ids as string[]).map((messageId) => ({ messageId, agentId: 'phone', state: 'delivered', via })) }
    } })
    t.service.start()
    await t.ask({ action: 'send', pane: '%1', to: 'phone', text: 'when you have a minute' })
    t.tick(60_000)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const statuses = async () => ((await t.ask({ action: 'history' })).messages as Array<{ statuses: unknown[] }>).at(-1)!.statuses
    expect(await statuses()).toEqual([expect.objectContaining({ machineId: 'm2', agentId: 'phone', state: 'delivered', via: 'read' })])
    via = 'typed'
    await t.ask({ action: 'send', pane: '%1', to: 'phone', text: 'and another' })
    t.tick(60_000)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(await statuses()).toEqual([expect.not.objectContaining({ via: expect.anything() })])
    t.service.stop()
  })
})

describe('a harness and the harnesses it started', () => {
  // Agent Messages off means off (owner, 2026-10-11): being started by a harness is no way to message it. Since #1180
  // the two messaged each other with no tab at all, and the owner found agents talking before turning any tab on.
  const start = (by: string, child: string, childMachine = 'm1') => new Ledger(ledgerPath(root)).append({
    at: 1, depth: 1, by: { machineId: 'm1', agentId: by, name: by, engine: 'codex' }, child: { machineId: childMachine, agentId: child, name: child },
  })

  it('may not message each other while Agent Messages are off, nor without a tab they share, either way', async () => {
    const t = setup({ tabs: [{ id: 'app', name: 'app', panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'web' }] }] })
    start('lead', 'web')
    t.setting(false)
    expect(await t.ask({ action: 'send', pane: '%1', to: 'web', text: 'Also check the footer.' })).toMatchObject({ error: 'MESSAGES_OFF' })
    expect(await t.ask({ action: 'send', pane: '%3', to: 'lead', text: 'Done: 3 fixes.' })).toMatchObject({ error: 'MESSAGES_OFF' })
    // Nor does `harness send` alone list them.
    expect(await t.ask({ action: 'send', pane: '%1' })).toMatchObject({ error: 'MESSAGES_OFF' })
    t.setting(true)
    const none = setup({ tabs: [] })
    expect(await none.ask({ action: 'send', pane: '%1', to: 'web', text: 'x' })).toMatchObject({ error: 'NO_TEAMMATES' })
    expect(await none.ask({ action: 'send', pane: '%3', to: 'lead', text: 'x' })).toMatchObject({ error: 'NO_TEAMMATES' })
    expect(String((await none.ask({ action: 'send', pane: '%1' })).roster)).not.toMatch(/\bweb\b/)
    expect(t.delivered).toEqual([])
    expect(none.delivered).toEqual([])
  })

  it('are refused as any other recipient outside the sender\'s tabs, and listed only as tab teammates', async () => {
    // lead and api share a tab; web, which lead started, is in none.
    const t = setup()
    start('lead', 'web')
    start('lead', 'api')
    const refused = await t.ask({ action: 'send', pane: '%1', to: 'web', text: 'x' })
    expect(refused).toEqual({ error: 'UNKNOWN_RECIPIENT', detail: 'No teammate named "web" in this tab. Teammates: api, phone.' })
    expect(await t.ask({ action: 'send', pane: '%3', to: 'lead', text: 'x' })).toMatchObject({ error: 'NO_TEAMMATES' })
    const roster = await t.ask({ action: 'send', pane: '%1' })
    expect(roster.roster).toContain('Teammates:')
    expect(roster.roster).not.toMatch(/\bweb\b/)
    expect(roster.roster).not.toContain('started you')
    // A child in the tab is a teammate like any other: reached through the tab, and logged there.
    const both = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'sync' })
    expect(both).toMatchObject({ tab: 'app', recipients: [{ name: 'api', state: 'queued' }] })
    expect(t.delivered.map(([agentId]) => agentId)).toEqual(['api'])
  })

  it('a message an older version queued between them under no tab is never delivered, read directory or not', async () => {
    vi.useFakeTimers()
    // Queued by 0.3.75 under its `started` log: one waiting in web's inbox for its hook, and one to api, which shares
    // a tab with lead now.
    const store = new MessageStore(join(root, 'state'))
    const old = (id: string, to: string) => ({ id, tabId: 'started', at: 1, text: 'Also check the footer.',
      from: { machineId: 'm1', agentId: 'lead', name: 'lead', engine: 'codex', machine: 'studio' }, to: [{ machineId: 'm1', agentId: to, name: to }] })
    const queue = (id: string, to: string, pane: string) => {
      store.record(old(id, to))
      store.status({ messageId: id, machineId: 'm1', agentId: to, state: 'queued', at: 1 })
      store.state.local.push({ key: deliveryKey(id, to), messageId: id, agentId: to, pane, session: `s-${to}`, state: 'queued', tries: 0, nextTryAt: 0, at: 1 })
      new PaneInbox(join(root, 'inbox-root')).put(pane, deliveryKey(id, to), { session: `s-${to}`, text: 'Also check the footer.' })
    }
    queue('m0000old', 'web', '%3')
    queue('m0000ol2', 'api', '%2')
    store.save()
    start('lead', 'web')
    // The directory cannot be read: they are failed all the same, before a hook can take them.
    const t = setup({ backendStatus: 500 })
    expect(t.inbox.waiting('%3', deliveryKey('m0000old', 'web'))).toBe(true)
    t.service.start()
    expect(t.inbox.waiting('%3', deliveryKey('m0000old', 'web'))).toBe(false)
    expect(t.inbox.waiting('%2', deliveryKey('m0000ol2', 'api'))).toBe(false)
    await vi.advanceTimersByTimeAsync(TICK_MS * 2)
    expect(t.delivered).toEqual([])
    const history = await t.ask({ action: 'history', tabId: 'started' })
    expect((history.messages as Array<{ statuses: unknown[] }>).map((m) => m.statuses)).toEqual([
      [expect.objectContaining({ machineId: 'm1', agentId: 'web', state: 'failed', reason: 'it was sent outside any tab' })],
      [expect.objectContaining({ machineId: 'm1', agentId: 'api', state: 'failed', reason: 'it was sent outside any tab' })],
    ])
    t.service.stop()
  })

  it('a hand-over an older machine logged under `started` is failed even between two in one tab', async () => {
    const t = setup()
    const answer = await t.ask({ action: 'deliver', message: { id: 'm00000cc', tabId: 'started', text: 'hi', at: 5,
      from: { machineId: 'm2', agentId: 'phone', name: 'phone', engine: 'claude', machine: 'laptop' }, to: [{ machineId: 'm1', agentId: 'api', name: 'api' }] } }, OWNER_REMOTE)
    expect(answer.statuses).toEqual([expect.objectContaining({ agentId: 'api', state: 'failed', reason: 'it was sent outside any tab' })])
    expect(t.delivered).toEqual([])
  })

  it('reach a tab teammate by the start of its id, for a harness whose name is a sentence', async () => {
    const titled = { ...session('abcdef99-1', '%3'), title: 'so we have built it, then' } as unknown as RegisteredSession
    const t = setup({ agents: [session('lead', '%1', 'codex'), titled],
      tabs: [{ id: 'app', name: 'app', panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'abcdef99-1' }] }] })
    expect((await t.ask({ action: 'send', pane: '%1', to: 'abcdef', text: 'x' })).recipients).toEqual([{ name: 'so we have built it, then', state: 'queued' }])
    // Too short to be an id's start.
    expect((await t.ask({ action: 'send', pane: '%1', to: 'abcde', text: 'x' })).error).toBe('UNKNOWN_RECIPIENT')
  })

  it('keep the record of a harness another machine started here, from that machine only', async () => {
    const t = setup()
    const row = { at: 5, depth: 2, by: { machineId: 'm2', agentId: 'phone', name: 'phone', engine: 'claude' }, child: { machineId: 'm1', agentId: 'web', name: 'web' } }
    expect(await t.ask({ action: 'started', row }, OWNER_REMOTE)).toEqual({ recorded: true })
    expect(new Ledger(ledgerPath(root)).parentOf({ machineId: 'm1', agentId: 'web' })).toMatchObject({ depth: 2, by: { machineId: 'm2' } })
    expect((await t.ask({ action: 'started', row }, OWNER_LOCAL)).error).toBe('REMOTE_ONLY')
    expect((await t.ask({ action: 'started', row: { ...row, child: { ...row.child, machineId: 'm3' } } }, OWNER_REMOTE)).error).toBe('INVALID_RECORD')
    expect((await t.ask({ action: 'started', row: { ...row, by: { ...row.by, machineId: 'm1' } } }, OWNER_REMOTE)).error).toBe('INVALID_RECORD')
    expect((await t.ask({ action: 'started' }, OWNER_REMOTE)).error).toBe('INVALID_RECORD')
    expect((await t.ask({ action: 'started', row: { ...row, child: { ...row.child, agentId: 'nobody' } } }, OWNER_REMOTE)).error).toBe('UNKNOWN_HARNESS')
    // The record lets neither message the other: phone is no teammate of web's.
    const delivered = await t.ask({ action: 'deliver', message: { id: 'm00000bb', tabId: 'started', text: 'hi', at: 5,
      from: { machineId: 'm2', agentId: 'phone', name: 'phone', engine: 'claude', machine: 'laptop' }, to: [{ machineId: 'm1', agentId: 'web', name: 'web' }] } }, OWNER_REMOTE)
    expect(delivered.statuses).toEqual([expect.objectContaining({ agentId: 'web', state: 'failed' })])
    expect(t.delivered).toEqual([])
  })

  it('stay apart across machines: another machine checks against its own tabs', async () => {
    const t = setup({ tabs: [] })
    start('lead', 'phone', 'm2')
    expect((await t.ask({ action: 'send', pane: '%1', to: 'phone', text: 'x' })).error).toBe('NO_TEAMMATES')
    // And while Agent Messages are off here, whatever the tabs say.
    t.tabs.push({ id: 'app', name: 'app', panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm2', agentId: 'phone' }] })
    t.notice({ type: 'desk_changed', revision: 5 })
    t.setting(false)
    expect((await t.ask({ action: 'send', pane: '%1', to: 'phone', text: 'x' })).error).toBe('MESSAGES_OFF')
    expect(t.rpcCalls.filter(([, p]) => p.action === 'deliver')).toEqual([])
  })
})

describe('harness tell: more work from the harness that started it', () => {
  // One way, from the starter, behind `agents-tell-agents` (tell.ts): not Agent Messages, which stay off means off.
  const start = (by: string, child: string, byMachine = 'm1', engine = 'codex') => new Ledger(ledgerPath(root)).append({
    at: 1, depth: 1, by: { machineId: byMachine, agentId: by, name: by, engine }, child: { machineId: 'm1', agentId: child, name: child },
  })
  /** Agent Messages off, as by default, and the person's say on telling. */
  const allow = (t: ReturnType<typeof setup>, on = true) => { t.setting(false); setAgentSettingsForTest(root, { agentsTellAgents: on }) }

  it('types more work into a harness it started, with Agent Messages off and no tab, saying who it is from', async () => {
    const t = setup({ tabs: [] })
    start('lead', 'web')
    allow(t)
    const reply = await t.ask({ action: 'tell', pane: '%1', machine: 'Mac Auto', agentId: 'web', text: 'Now add tests for the footer.' })
    expect(reply).toMatchObject({ state: 'queued' })
    const id = reply.id as string
    expect(t.delivered).toHaveLength(1)
    const [agentId, text, deliveryId] = t.delivered[0]
    expect(agentId).toBe('web')
    expect(deliveryId).toBe(`team:msg:${deliveryKey(id, 'web')}:1`)
    // Named as the starter's CLI names its machine, not by the host: Agent Messages' directory is not read while off.
    expect(text).toBe('[from lead · Codex · Mac Auto, the harness that started you: more work. It reads your answer itself.]\n\nNow add tests for the footer.')
    // No roster note: it has no teammates to message.
    expect(text).not.toContain('Agent Messages are on')
    t.deliveryEvent({ deliveryId, sessionId: 'web', state: 'started' })
    const history = await t.ask({ action: 'history', tabId: 'told' })
    expect(history.messages).toEqual([expect.objectContaining({ id, statuses: [expect.objectContaining({ agentId: 'web', state: 'delivered', via: 'prompt' })] })])
  })

  it('is refused until the person turns it on, and for any harness its caller did not start, either way', async () => {
    const t = setup({ tabs: [] })
    start('lead', 'web')
    start('lead', 'gone')
    t.setting(false)
    expect(await t.ask({ action: 'tell', pane: '%1', agentId: 'web', text: 'x' })).toMatchObject({ error: 'TELL_OFF', detail: expect.stringContaining('agents-tell-agents') })
    allow(t)
    // api was the person's; the started one may not tell its starter; a harness no longer running is said so.
    expect(await t.ask({ action: 'tell', pane: '%1', agentId: 'api', text: 'x' })).toMatchObject({ error: 'NOT_YOURS' })
    expect(await t.ask({ action: 'tell', pane: '%3', agentId: 'lead', text: 'x' })).toMatchObject({ error: 'NOT_YOURS' })
    expect(await t.ask({ action: 'tell', pane: '%1', agentId: 'gone', text: 'x' })).toMatchObject({ error: 'NOT_RUNNING' })
    expect(await t.ask({ action: 'tell', pane: '%9', agentId: 'web', text: 'x' })).toMatchObject({ error: 'NOT_A_HARNESS' })
    expect(await t.ask({ action: 'tell', agentId: 'web', text: 'x' })).toMatchObject({ error: 'NOT_A_HARNESS' })
    expect(await t.ask({ action: 'tell', pane: '%1', agentId: 'web', text: '  ' })).toMatchObject({ error: 'USAGE' })
    expect(await t.ask({ action: 'tell', pane: '%1', text: 'x' })).toMatchObject({ error: 'USAGE' })
    expect(await t.ask({ action: 'tell', pane: '%1', agentId: 'web', text: 'x'.repeat(LIMITS.text + 1) })).toMatchObject({ error: 'TOO_LONG' })
    // What a pane's request names as its sender is never read: it is the pane's harness.
    expect(await t.ask({ action: 'tell', pane: '%2', from: { machineId: 'm1', agentId: 'lead' }, agentId: 'web', text: 'x' })).toMatchObject({ error: 'NOT_YOURS' })
    expect(t.delivered).toEqual([])
  })

  it('from another of the owner\'s machines, is checked against this machine\'s own record of who started it', async () => {
    const t = setup({ tabs: [] })
    start('phone', 'web', 'm2', 'claude')
    allow(t)
    const from = { machineId: 'm2', agentId: 'phone' }
    expect(await t.ask({ action: 'tell', from, machine: 'laptop', agentId: 'web', text: 'Ship the fix.' }, OWNER_REMOTE)).toMatchObject({ state: 'queued' })
    expect(t.delivered[0][1]).toBe('[from phone · Claude Code · laptop, the harness that started you: more work. It reads your answer itself.]\n\nShip the fix.')
    // Another harness on that machine, or one claiming to be this machine's over the relay.
    expect(await t.ask({ action: 'tell', from: { machineId: 'm2', agentId: 'other' }, agentId: 'web', text: 'x' }, OWNER_REMOTE)).toMatchObject({ error: 'NOT_YOURS' })
    expect(await t.ask({ action: 'tell', from: { machineId: 'm1', agentId: 'lead' }, agentId: 'web', text: 'x' }, OWNER_REMOTE)).toMatchObject({ error: 'NOT_FROM_THERE' })
    expect(await t.ask({ action: 'tell', agentId: 'web', text: 'x' }, OWNER_REMOTE)).toMatchObject({ error: 'INVALID_REQUEST' })
    expect(t.delivered).toHaveLength(1)
  })

  it('waits while the harness is busy, and is refused at the next look once the person turns it off', async () => {
    vi.useFakeTimers()
    const t = setup({ tabs: [] })
    start('lead', 'web')
    allow(t)
    t.service.start()
    const reply = await t.ask({ action: 'tell', pane: '%1', agentId: 'web', text: 'More.' })
    t.deliveryEvent({ deliveryId: t.delivered.at(-1)![2], sessionId: 'web', state: 'rejected', reason: 'team_waiting_draft' })
    // Off sleeps Agent Messages; the mailbox still looks while this waits, and tries again once its wait is over.
    t.tick(MAX_BACKOFF_MS)
    await vi.advanceTimersByTimeAsync(PUMP_MS * 2)
    expect(t.delivered.length).toBeGreaterThan(1)
    setAgentSettingsForTest(root, { agentsTellAgents: false })
    t.deliveryEvent({ deliveryId: t.delivered.at(-1)![2], sessionId: 'web', state: 'rejected', reason: 'team_waiting_draft' })
    const tries = t.delivered.length
    t.tick(MAX_BACKOFF_MS)
    await vi.advanceTimersByTimeAsync(PUMP_MS * 2)
    expect(t.delivered).toHaveLength(tries)
    const history = await t.ask({ action: 'history', tabId: 'told' })
    expect(history.messages).toEqual([expect.objectContaining({ id: reply.id, statuses: [expect.objectContaining({ state: 'failed', reason: expect.stringContaining('agents-tell-agents') })] })])
    t.service.stop()
  })

  it('a hand-over under `told` from another machine is no way around the tabs', async () => {
    const t = setup({ tabs: [] })
    start('phone', 'web', 'm2', 'claude')
    allow(t)
    const answer = await t.ask({ action: 'deliver', message: { id: 'm00000dd', tabId: 'told', text: 'hi', at: 5,
      from: { machineId: 'm2', agentId: 'phone', name: 'phone', engine: 'claude', machine: 'laptop' }, to: [{ machineId: 'm1', agentId: 'web', name: 'web' }] } }, OWNER_REMOTE)
    expect(answer.statuses).toEqual([expect.objectContaining({ agentId: 'web', state: 'failed' })])
    expect(t.delivered).toEqual([])
  })
})

describe('from the owner\'s other machines', () => {
  const incoming =(to = 'api', from = { machineId: 'm2', agentId: 'phone' }) => ({
    id: 'm00000aa', tabId: 'app', text: 'from the phone', at: 5,
    from: { ...from, name: 'phone', engine: 'claude', machine: 'laptop' },
    to: [{ machineId: 'm1', agentId: to, name: to }],
  })

  it('delivers a message for one of this machine\'s agents that shares an on tab with the sender, once', async () => {
    const t = setup()
    const answer = await t.ask({ action: 'deliver', message: incoming() }, OWNER_REMOTE)
    expect(answer.statuses).toEqual([expect.objectContaining({ messageId: 'm00000aa', machineId: 'm1', agentId: 'api', state: 'queued' })])
    expect(t.delivered).toHaveLength(1)
    // Handed over again after a lost reply: the same delivery, not a second.
    await t.ask({ action: 'deliver', message: incoming() }, OWNER_REMOTE)
    expect(t.delivered).toHaveLength(1)
    t.deliveryEvent({ deliveryId: t.delivered[0][2], sessionId: 'api', state: 'delivered' })
    expect(await t.ask({ action: 'status', ids: ['m00000aa', 'unknown'] }, OWNER_REMOTE)).toEqual({ statuses: [expect.objectContaining({ state: 'delivered', via: 'prompt' })] })
  })

  it('takes a hand-over only from another machine, never naming this one as the sender, and not while the directory is unknown', async () => {
    const t = setup()
    expect(await t.ask({ action: 'deliver', message: incoming() }, OWNER_LOCAL)).toMatchObject({ error: 'REMOTE_ONLY' })
    expect(await t.ask({ action: 'status', ids: [] }, OWNER_LOCAL)).toMatchObject({ error: 'REMOTE_ONLY' })
    expect(await t.ask({ action: 'who', agentIds: [] }, OWNER_LOCAL)).toMatchObject({ error: 'REMOTE_ONLY' })
    expect(await t.ask({ action: 'deliver', message: incoming('api', { machineId: 'm1', agentId: 'lead' }) }, OWNER_REMOTE)).toMatchObject({ error: 'NOT_FROM_THERE' })
    expect(t.delivered).toHaveLength(0)
    const down = setup({ backendStatus: 500 })
    expect(await down.ask({ action: 'deliver', message: incoming() }, OWNER_REMOTE)).toMatchObject({ error: 'DIRECTORY_UNAVAILABLE' })
  })

  it('refuses a hand-over once too many messages wait on this machine', async () => {
    const t = setup()
    for (let i = 0; i < LIMITS.waiting; i++) {
      const m = { ...incoming(), id: `m${String(i).padStart(7, '0')}` }
      await t.ask({ action: 'deliver', message: m }, OWNER_REMOTE)
      t.deliveryEvent({ deliveryId: t.delivered.at(-1)![2], sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    }
    expect(await t.ask({ action: 'deliver', message: { ...incoming(), id: 'mzzzzzzz' } }, OWNER_REMOTE)).toMatchObject({ error: 'MAILBOX_FULL' })
    // Five hundred deliveries, each saved to disk: about five seconds on a busy machine.
  }, 30_000)

  it('refuses a message for an agent outside the sender\'s tabs, and one that is not a message', async () => {
    const t = setup()
    const answer = await t.ask({ action: 'deliver', message: incoming('web') }, OWNER_REMOTE)
    expect(answer.statuses).toEqual([expect.objectContaining({ agentId: 'web', state: 'failed', reason: 'it is not in a tab with the sender' })])
    expect(t.delivered).toHaveLength(0)
    expect(await t.ask({ action: 'deliver', message: { id: 'x' } }, OWNER_REMOTE)).toMatchObject({ error: 'INVALID_MESSAGE' })
  })

  it('refuses a hand-over while this machine has Agent Messages off, whatever the sender\'s machine says', async () => {
    // Each computer has its own switch: the sender's had it on, and this one's person turned it off.
    const t = setup()
    t.setting(false)
    const answer = await t.ask({ action: 'deliver', message: incoming() }, OWNER_REMOTE)
    expect(answer.statuses).toEqual([expect.objectContaining({ agentId: 'api', state: 'failed', reason: 'Agent Messages are off on its computer' })])
    expect(t.delivered).toEqual([])
    expect(t.inbox.waiting('%2', deliveryKey('m00000aa', 'api'))).toBe(false)
  })

  it('names its agents for another machine, and only those it has', async () => {
    const t = setup()
    expect(await t.ask({ action: 'who', agentIds: ['api', 'ghost', 3] }, OWNER_REMOTE)).toEqual({ agents: [{ agentId: 'api', name: 'api', engine: 'claude', project: 'api', state: 'unknown' }] })
    expect(await t.ask({ action: 'who' }, OWNER_REMOTE)).toEqual({ agents: [] })
    expect(await t.ask({ action: 'status' }, OWNER_REMOTE)).toEqual({ statuses: [] })
  })
})

describe('the roster note and the directory', () => {
  it('puts the note in each agent\'s inbox once the tab has a teammate, and takes it back when Agent Messages are turned off', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.service.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const waiting = (pane: string) => {
      const dir = t.inbox.paneDir(pane)!
      try { return require('node:fs').readdirSync(dir) as string[] } catch { return [] }
    }
    expect(waiting('%1').some((n) => n.startsWith('0note-'))).toBe(true)
    expect(waiting('%2').some((n) => n.startsWith('0note-'))).toBe(true)
    // Web shares no tab: nothing.
    expect(waiting('%3')).toEqual([])
    // The hook took lead's note: it is not put again.
    const note = waiting('%1').find((n) => n.startsWith('0note-'))!.replace(/\.json$/, '')
    require('node:fs').mkdirSync(join(root, 'inbox-root', 'claimed'), { recursive: true })
    require('node:fs').renameSync(join(t.inbox.paneDir('%1')!, `${note}.json`), join(root, 'inbox-root', 'claimed', `1-${note}.json`))
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(waiting('%1')).toEqual([])
    // Turned off: the notes go at the next look, with no word from the backend.
    t.setting(false)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(waiting('%2')).toEqual([])
    // On again: put back.
    t.setting(true)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(waiting('%2').some((n) => n.startsWith('0note-'))).toBe(true)
    t.service.stop()
  })

  it('tells every harness of an unshared tab who leads it, as the tab setting lists it: the leader its role, the others theirs', async () => {
    vi.useFakeTimers()
    const tabs = [{ id: 'app', name: 'app', leader: { machineId: 'm1', agentId: 'lead' } as { machineId: string; agentId: string } | null,
      panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'api' }, { machineId: 'm2', agentId: 'phone' }] }]
    const t = setup({ tabs })
    const roster = async (pane: string) => String((await t.ask({ action: 'send', pane })).roster)
    // The leader is told it leads; its teammates, on this machine, by the name they reach it by. No shared tab's lines.
    expect(await roster('%1')).toBe(['[Harness] Agent Messages are on in tab "app". Teammates:', '  api    Claude Code · studio · api',
      '  phone  Claude Code · laptop · app', RULES, LEADER_ROLE].join('\n'))
    expect(await roster('%2')).toBe(['[Harness] Agent Messages are on in tab "app". Teammates:', '  lead   Codex · studio · lead',
      '  phone  Claude Code · laptop · app', RULES, WORKER_ROLE('lead')].join('\n'))
    // The notes in each agent's inbox say it too.
    t.service.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const notes = (pane: string) => {
      const dir = t.inbox.paneDir(pane)!
      return (require('node:fs').readdirSync(dir) as string[]).filter((n) => n.startsWith('0note-'))
        .map((n) => JSON.parse(require('node:fs').readFileSync(join(dir, n), 'utf8')).text as string)
    }
    expect(notes('%1')).toEqual([await roster('%1')])
    expect(notes('%2')).toEqual([await roster('%2')])
    // The leader's pane left the tab: the listing names no leader (the backend derives it), and at the next read every
    // note loses its role, given again once.
    tabs[0].leader = null
    t.notice({ type: 'desk_changed', revision: 5 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(notes('%1')).toEqual([expect.stringMatching(/Teammates:/)])
    expect(notes('%1')[0].endsWith(RULES)).toBe(true)
    expect(notes('%2')[0].endsWith(RULES)).toBe(true)
    t.service.stop()
  })

  it('names no leader that is no teammate of the harness, nor one a backend from before tab leaders never lists', async () => {
    const panes = [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'api' }]
    const elsewhere = setup({ tabs: [{ id: 'app', name: 'app', leader: { machineId: 'm9', agentId: 'gone' }, panes }] })
    expect(String((await elsewhere.ask({ action: 'send', pane: '%1' })).roster).endsWith(RULES)).toBe(true)
    const old = setup({ tabs: [{ id: 'app', name: 'app', panes }] })
    expect(String((await old.ask({ action: 'send', pane: '%1' })).roster).endsWith(RULES)).toBe(true)
    // A leader that is no harness at all is taken as none listed.
    const odd = setup({ tabs: [{ id: 'app', name: 'app', leader: { machineId: 7, agentId: 'lead' } as unknown as { machineId: string; agentId: string }, panes }] })
    expect(String((await odd.ask({ action: 'send', pane: '%1' })).roster).endsWith(RULES)).toBe(true)
  })

  it('counts Agent Messages turned on or off as a change of the directory, at its next read', async () => {
    // Deliveries and notes get another look at once, as for a tab changed (messages/directory.ts).
    vi.useFakeTimers()
    const t = setup()
    t.service.start()
    await vi.advanceTimersByTimeAsync(0)
    const reads = () => t.changed.mock.calls.length
    const first = reads()
    expect(first).toBeGreaterThan(0)
    // Read again with nothing changed: no change.
    t.notice({ type: 'desk_changed', revision: 4 })
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(first)
    t.setting(false)
    t.notice({ type: 'desk_changed', revision: 4 })
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(first + 1)
    t.notice({ type: 'desk_changed', revision: 4 })
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(first + 1)
    t.setting(true)
    t.notice({ type: 'desk_changed', revision: 4 })
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(first + 2)
    t.service.stop()
  })

  it('keys each harness\'s inbox by its backend: `%3` on tmux and `%3` on a pty host are two inboxes', async () => {
    vi.useFakeTimers()
    const tabs = [{ id: 'app', name: 'app', panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'api' }, { machineId: 'm1', agentId: 'web' }] }]
    const t = setup({ tabs, agents: [session('lead', '%3', 'codex'), ptySession('api', '%3'), session('web', '%4')] })
    t.service.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const fs = require('node:fs') as typeof import('node:fs')
    const state = JSON.parse(fs.readFileSync(join(root, 'state', 'state.json'), 'utf8'))
    expect(state.notes.lead.pane).toBe('tmux\u0000%3')
    expect(state.notes.api.pane).toBe('ptyhost\u0000p1\u0000%3')
    const notes = (pane: string) => (fs.readdirSync(t.inbox.paneDir(pane)!) as string[]).filter((n) => n.startsWith('0note-'))
    expect(notes('tmux\u0000%3')).toHaveLength(1)
    expect(notes('ptyhost\u0000p1\u0000%3')).toHaveLength(1)
    // `harness send` from tmux's `%3` is lead's, never the pty host pane's of the same id.
    const sent = await t.ask({ action: 'send', pane: '%3', to: 'api', text: 'over to you' })
    expect(sent.recipients).toEqual([{ name: 'api', state: 'queued' }])
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const delivery = (JSON.parse(fs.readFileSync(join(root, 'state', 'state.json'), 'utf8')).local as Array<{ agentId: string; pane: string }>).find((d) => d.agentId === 'api')!
    expect(delivery.pane).toBe('ptyhost\u0000p1\u0000%3')
    t.service.stop()
  })

  it('a bare `%N` names a tmux pane only; a pty host pane is named by its own `<instance>:%N`', async () => {
    const tabs = [{ id: 'app', name: 'app', panes: [{ machineId: 'm1', agentId: 'a' }, { machineId: 'm1', agentId: 'b' }] }]
    const t = setup({ tabs, agents: [ptySession('a', '%5'), session('b', '%6')] })
    expect((await t.ask({ action: 'send', pane: '%5', to: 'b', text: 'hi' })).error).toBe('NOT_A_HARNESS')
    expect((await t.ask({ action: 'send', pane: 'p1:%5', to: 'b', text: 'hi' })).recipients).toEqual([{ name: 'b', state: 'queued' }])
    expect((await t.ask({ action: 'send', pane: 'p2:%5', to: 'b', text: 'hi' })).error).toBe('NOT_A_HARNESS')
  })

  it('names a versioned pty host\'s pane by its own instance: p2-0.4.21-dev.win1:%7 and p2-h0123456789ab:%7', async () => {
    const tabs = [{ id: 'app', name: 'app', panes: ['a', 'b', 'c'].map((agentId) => ({ machineId: 'm1', agentId })) }]
    const t = setup({ tabs, agents: [ptySession('a', '%7', 'claude', 'p2-0.4.21-dev.win1'), ptySession('b', '%7', 'claude', 'p2-h0123456789ab'), session('c', '%6')] })
    expect((await t.ask({ action: 'send', pane: 'p2-0.4.21-dev.win1:%7', to: 'c', text: 'hi' })).recipients).toEqual([{ name: 'c', state: 'queued' }])
    expect((await t.ask({ action: 'send', pane: 'p2-h0123456789ab:%7', to: 'c', text: 'hi' })).recipients).toEqual([{ name: 'c', state: 'queued' }])
    expect((await t.ask({ action: 'send', pane: 'p2-0.4.22:%7', to: 'c', text: 'hi' })).error).toBe('NOT_A_HARNESS')
  })

  it('keeps the notes it put in the store, withdraws a gone harness\'s, and sweeps old files nothing waits on', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.service.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const fs = require('node:fs') as typeof import('node:fs')
    const state = () => JSON.parse(fs.readFileSync(join(root, 'state', 'state.json'), 'utf8'))
    expect(Object.keys(state().notes).sort()).toEqual(['api', 'lead'])
    // api's harness is gone: its note goes with it.
    t.agents.splice(1, 1)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(Object.keys(state().notes)).toEqual(['lead'])
    expect(t.inbox.paneDir('%2') && fs.existsSync(t.inbox.paneDir('%2')!)).toBe(false)
    t.service.stop()
    // A file nothing here waits on, from a service long gone: swept at the next start once it is old.
    t.inbox.put('%7', 'm0000999-aaaa', { session: 'gone', text: 'stale' })
    const old = (Date.now() - SWEEP_AFTER_MS - 1000) / 1000
    fs.utimesSync(join(t.inbox.paneDir('%7')!, 'm0000999-aaaa.json'), old, old)
    t.inbox.put('%8', 'fresh', { session: 'other daemon', text: 'fresh' })
    const again = startAgentMessages(fakeCore({ dataDir: root, daemon: { machineId: () => 'm1', port: 18473 }, agents: { live: () => t.agents, displayName: (s) => (s as unknown as { title: string }).title, terminalAvailable: () => true }, account: { backend: t.backend } }),
      { stateDir: join(root, 'state'), inboxRoot: join(root, 'inbox-root'), now: () => Date.now() })
    again.start()
    expect(t.inbox.waiting('%7', 'm0000999-aaaa')).toBe(false)
    expect(t.inbox.waiting('%8', 'fresh')).toBe(true)
    again.reconnected?.()
    again.stop()
  })

  it('holds a waiting delivery while Agent Messages are off, goes on once they are on again, and fails it later', async () => {
    // Turned off by a slip of the mouse and on again a minute later, a tab's switch failed the message waiting in it
    // (2026-10-12). The switch is the account's now (Settings ▸ Experimental), and a slip there must cost nothing either.
    vi.useFakeTimers()
    const t = setup()
    t.service.start()
    const reply = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })
    t.deliveryEvent({ deliveryId: t.delivered[0][2], sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    const key = deliveryKey(reply.id as string, 'api')
    const status = async () => ((await t.ask({ action: 'history', limit: 10 })).messages as Array<{ id: string; statuses: Array<{ state: string; reason?: string }> }>)
      .find((m) => m.id === reply.id)!.statuses[0]
    const turn = async (on: boolean) => {
      t.setting(on)
      t.notice({ type: 'desk_changed', revision: 6 })
      await vi.advanceTimersByTimeAsync(0)
    }
    await turn(false)
    expect(await status()).toMatchObject({ state: 'queued', reason: HELD_OFF_REASON })
    // Given to no one meanwhile: out of the hook's reach.
    expect(t.inbox.waiting('%2', key)).toBe(false)
    t.tick(HELD_OUTSIDE_MS - 1)
    await vi.advanceTimersByTimeAsync(PUMP_MS)
    expect(await status()).toMatchObject({ state: 'queued', reason: HELD_OFF_REASON })
    const attempts = t.delivered.length
    await turn(true)
    await vi.advanceTimersByTimeAsync(PUMP_MS)
    // Carried again: put back, and typed into the idle agent.
    expect(t.delivered.length).toBe(attempts + 1)
    expect(t.delivered.at(-1)![2]).toContain(key)
    expect((await status()).reason).not.toBe(HELD_OFF_REASON)
    t.deliveryEvent({ deliveryId: t.delivered.at(-1)![2], sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    // Off for good: held a while again, then failed.
    await turn(false)
    expect(await status()).toMatchObject({ state: 'queued', reason: HELD_OFF_REASON })
    t.tick(HELD_OUTSIDE_MS)
    await vi.advanceTimersByTimeAsync(PUMP_MS)
    expect(await status()).toMatchObject({ state: 'failed', reason: 'Agent Messages were turned off on its computer' })
    expect(t.inbox.waiting('%2', key)).toBe(false)
    t.service.stop()
  })

  it('answers a failure it did not expect without saying more', async () => {
    const t = setup()
    const broken = startAgentMessages(fakeCore({ dataDir: root, agents: { live: () => { throw new Error('boom') } } }), { stateDir: join(root, 's2'), inboxRoot: join(root, 'i2') })
    expect(await broken.requests.agent_messages!({ action: 'send', pane: '%1', to: 'a', text: 'b' }, OWNER_LOCAL)).toEqual({ error: 'MESSAGES_UNAVAILABLE', detail: expect.any(String) })
    broken.stop()
    t.service.stop()
  })
})

describe('off costs nothing', () => {
  // It runs in the edge host on every computer (2026-10-12). Off, or signed out, a read of the account's tabs every
  // 15 s and three timers carried messages it never could.
  const waitingFromBefore = (id = 'm0000w01') => {
    const store = new MessageStore(join(root, 'state'))
    store.record({ id, tabId: 'app', at: 1, text: 'from before',
      from: { machineId: 'm2', agentId: 'phone', name: 'phone', engine: 'claude', machine: 'laptop' }, to: [{ machineId: 'm1', agentId: 'api', name: 'api' }] })
    store.status({ messageId: id, machineId: 'm1', agentId: 'api', state: 'queued', at: 1 })
    store.state.local.push({ key: deliveryKey(id, 'api'), messageId: id, agentId: 'api', pane: '%2', session: 's-api', state: 'queued', tries: 0, nextTryAt: 0, at: 1 })
    new PaneInbox(join(root, 'inbox-root')).put('%2', deliveryKey(id, 'api'), { session: 's-api', text: 'from before' })
    store.save()
    return deliveryKey(id, 'api')
  }
  const statusOf = async (t: ReturnType<typeof setup>, id: string) =>
    ((await t.ask({ action: 'history' })).messages as Array<{ id: string; statuses: Array<{ state: string; reason?: string }> }>).find((m) => m.id === id)!.statuses[0]

  it('off from the start: reads no tabs and puts no note; holds what waits, fails it later, then runs no timer; on, it wakes', async () => {
    vi.useFakeTimers()
    const key = waitingFromBefore()
    const t = setup()
    t.setting(false)
    t.service.start()
    await vi.advanceTimersByTimeAsync(0)
    // Held out of the hook's reach at once, the tabs unread: off, no tab carries a message, whatever they say.
    expect(t.inbox.waiting('%2', key)).toBe(false)
    expect(await statusOf(t, 'm0000w01')).toMatchObject({ state: 'queued', reason: HELD_OFF_REASON })
    t.notice({ type: 'desk_changed', revision: 9 })
    t.notice({ type: 'machines_changed', reason: 'renamed' })
    await vi.advanceTimersByTimeAsync(PUMP_MS)
    expect(await statusOf(t, 'm0000w01')).toMatchObject({ state: 'queued', reason: HELD_OFF_REASON })
    t.tick(HELD_OUTSIDE_MS)
    await vi.advanceTimersByTimeAsync(PUMP_MS)
    expect(await statusOf(t, 'm0000w01')).toMatchObject({ state: 'failed', reason: 'Agent Messages were turned off on its computer' })
    // Settled: nothing runs, and a minute goes by with no read and no note.
    await vi.advanceTimersByTimeAsync(PUMP_MS)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.backend).not.toHaveBeenCalled()
    expect(t.inbox.waiting('%1', 'anything')).toBe(false)
    expect(t.watchers.size).toBe(1)
    // The file is heard more than once before it is read: read once.
    for (const heard of [...t.watchers]) { heard(); heard() }
    await vi.advanceTimersByTimeAsync(0)
    expect(t.backend).not.toHaveBeenCalled()
    // Turned on for the account and kept here: the watch wakes it, and the notes go out at its next look.
    t.setting(true)
    await vi.advanceTimersByTimeAsync(0)
    // Its tabs, and once the shared tabs too (service.ts `sharedUp`).
    expect(t.backend.mock.calls.map((c) => c[1]).sort()).toEqual(['/api/agent-messages', '/api/agent-messages/shares'])
    expect(t.watchers.size).toBe(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const notes = (pane: string) => (require('node:fs').readdirSync(t.inbox.paneDir(pane)!) as string[]).filter((n) => n.startsWith('0note-'))
    expect(notes('%1')).toHaveLength(1)
    expect(notes('%2')).toHaveLength(1)
    // Its tabs every 15 s, its deliveries every 2 s, its notes and outbox every 5 s.
    expect(vi.getTimerCount()).toBe(3)
    t.service.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(t.watchers.size).toBe(0)
  })

  it('signed out: reads no tabs, runs no timer and watches nothing; signed in at its next core, it wakes', async () => {
    vi.useFakeTimers()
    let signedIn = false
    const t = setup({ signedIn: () => signedIn })
    t.service.start()
    await vi.advanceTimersByTimeAsync(TICK_MS * 4)
    expect(t.backend).not.toHaveBeenCalled()
    expect(t.watchers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    // Its requests are answered all the same.
    expect(await t.ask({ action: 'history' })).toEqual({ messages: [] })
    signedIn = true
    t.service.reconnected!()
    await vi.advanceTimersByTimeAsync(0)
    // Its tabs, and once the shared tabs too (service.ts `sharedUp`).
    expect(t.backend.mock.calls.map((c) => c[1]).sort()).toEqual(['/api/agent-messages', '/api/agent-messages/shares'])
    expect(vi.getTimerCount()).toBe(3)
    // Turned off at its next look, then signed out: the watch goes with the rest.
    t.setting(false)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(t.watchers.size).toBe(1)
    signedIn = false
    t.service.reconnected!()
    expect(t.watchers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    t.service.stop()
  })

  it('hands over what it sent another machine once it is on again, not while it is off', async () => {
    vi.useFakeTimers()
    let away = true
    const handed: string[] = []
    const t = setup({ rpc: async (_target, payload) => {
      if (payload.action === 'who') return { agents: [{ agentId: 'phone', name: 'phone', engine: 'claude' }] }
      if (payload.action === 'deliver') {
        handed.push((payload.message as { id: string }).id)
        if (away) throw new MessageError('DISCONNECTED', 'away')
        return { statuses: [{ messageId: (payload.message as { id: string }).id, agentId: 'phone', state: 'queued' }] }
      }
      return { statuses: [] }
    } })
    t.service.start()
    const reply = await t.ask({ action: 'send', pane: '%1', to: 'phone', text: 'when you are back' })
    expect(handed).toEqual([reply.id])
    t.setting(false)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    away = false
    t.tick(10 * 60_000)
    await vi.advanceTimersByTimeAsync(TICK_MS * 3)
    expect(handed).toEqual([reply.id])
    t.setting(true)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(handed).toEqual([reply.id, reply.id])
    t.service.stop()
  })

  it('wakes when the core tells it its switch changed, with no file to hear', async () => {
    // A computer whose switches are all at their defaults has no file to watch: the daemon's write tells it.
    vi.useFakeTimers()
    const t = setup()
    t.setting(false)
    t.service.start()
    await vi.advanceTimersByTimeAsync(0)
    t.service.settingsChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.backend).not.toHaveBeenCalled()
    // Written on, with no watch to hear it: told, it reads its switch again and wakes.
    setAgentSettingsForTest(root, { agentMessages: true })
    t.service.settingsChanged()
    await vi.advanceTimersByTimeAsync(0)
    // Its tabs, and once the shared tabs too (service.ts `sharedUp`).
    expect(t.backend.mock.calls.map((c) => c[1]).sort()).toEqual(['/api/agent-messages', '/api/agent-messages/shares'])
    expect(vi.getTimerCount()).toBe(3)
    t.service.stop()
  })

  it('hears its setting\'s own file while off, with no watch given', async () => {
    setAgentSettingsForTest(root, { agentMessages: false })
    const backend = vi.fn(async () => ({ status: 503, body: {} }))
    const real = startAgentMessages(fakeCore({ dataDir: root, account: { backend } }), { stateDir: join(root, 's3'), inboxRoot: join(root, 'i3') })
    real.start()
    setAgentSettingsForTest(root, { agentMessages: true })
    for (let i = 0; i < 250 && !backend.mock.calls.length; i++) await new Promise((settle) => setTimeout(settle, 20))
    expect(backend).toHaveBeenCalled()
    real.stop()
  })
})
