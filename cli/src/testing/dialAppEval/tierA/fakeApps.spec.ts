// Tier A's fake Claude app and fake ChatGPT app (fakeApps.ts) on a fake world: the commands a tap runs, as each platform
// runs them, the session a link resumes, told to devices that record it, and what each app says of the session it
// shows, told to the devices' own listener handlers. Every folder is a temp one, on virtual time.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxAnswer, InboxPoll } from '../../../core/deviceHookCalls.js'
import type { ObservedEvent } from '../../../core/observedHook.js'
import { attachHandler, threadHandler } from '../../../services/devicesListener.js'
import { codexAppFixture } from '../../codexAppFixture.js'
import { claudeSession, thread } from '../catalog.js'
import type { App, Delivery, Platform, Scenario, SessionKey } from '../types.js'
import { installFakeApps } from './fakeApps.js'
import { machine } from './machine.js'
import type { TierAWorld } from './world.js'

const roots: string[] = []
// The apps' moment is virtual; setImmediate stays real, so what they tell lands.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const MIN = 60_000
/** How long an app takes to show and resume what a link opens. */
const OPEN_MS = 500
const scenario: Scenario = {
  id: 'S1', app: 'claude', title: 'Eval links', dims: ['D3'], platforms: ['darwin', 'win32', 'linux'], tiers: ['a'],
  heldOut: false, steps: [], checks: [], probes: [],
  sessions: [claudeSession('a', MIN, { resumable: true }), claudeSession('b', MIN), thread('t1', MIN, { resumable: true }),
    thread('t2', MIN), claudeSession('z', MIN, { resumable: true, ghost: true })],
}
const by = (key: SessionKey) => scenario.sessions.find((s) => s.key === key)!
const [a, b, t1, t2, z] = [by('a'), by('b'), by('t1'), by('t2'), by('z')]
const CLAUDE_APP = 'com.anthropic.claudefordesktop'
const CHATGPT_APP = 'com.openai.codex'
const claudeLink = (localId: string) => `claude://code/continue?session=${localId}`
const codexLink = (id: string) => `codex://threads/${id}`

/** The command that opens a link, as each platform's devices run it (cable/hosts/appLink.ts, the Windows raise). */
function opener(platform: Platform, link: string, bundle: string): string[] {
  if (platform === 'darwin') return ['/usr/bin/open', '-b', bundle, link]
  if (platform === 'linux') return ['/usr/bin/xdg-open', link]
  return ['harness-pty', 'open-link', link, bundle]
}

/** A world whose devices record what they are told, with the fake apps installed on its commands. */
function fakeWorld(platform: Platform, more: { front?: App | 'other'; of?: Scenario } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dial-eval-apps-'))
  roots.push(root)
  machine.reset()
  const told: ObservedEvent[] = []
  const polls: InboxPoll[] = []
  const shown = { attached: [] as string[], titles: [] as string[] }
  const gaps: string[] = []
  const rules: Array<(argv: readonly string[]) => { code: number } | undefined> = []
  const devices = {
    observed: (event: ObservedEvent) => { told.push(event); return true },
    inboxPoll: (poll: InboxPoll) => { polls.push(poll); return new Promise<InboxAnswer>(() => {}) },
    inboxGone: () => {},
  }
  const codexHome = codexAppFixture(join(root, '.codex'))
  const world = {
    scenario: more.of ?? scenario, platform, machine, codexHome, front: more.front ?? 'claude',
    ports: { devices },
    listener: {
      attach: attachHandler((sessionId) => shown.attached.push(sessionId)),
      thread: threadHandler((title) => shown.titles.push(title)),
    },
    folders: { claudeProjects: join(root, 'projects'), codexSessions: join(root, 'codex', 'sessions') },
    session: by,
    deliver: (_d: Omit<Delivery, 'at'>) => {},
    answer: (rule: (typeof rules)[number]) => { rules.push(rule) },
    gap: (reason: string) => { gaps.push(reason) },
  } as unknown as TierAWorld
  installFakeApps(world)
  /** A command the devices ran: the first rule that answers decides. */
  const ran = (argv: string[]) => rules.map((rule) => rule(argv)).find((answer) => answer !== undefined)
  const started = () => told.filter((e) => e.event === 'session-start').map((e) => e.sessionId)
  return { ran, told, polls, started, shown, gaps, codexHome }
}

/** The apps' moment passes, and what they told lands. */
async function later(ms = OPEN_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await new Promise((resolve) => { setImmediate(resolve) })
}

describe("tier A's fake apps", () => {
  it.each(['darwin', 'linux', 'win32'] as const)('a link for a resumable resting session starts it once, a moment after it ran (%s)', async (platform) => {
    const w = fakeWorld(platform)
    w.ran(opener(platform, claudeLink(a.localId!), CLAUDE_APP))
    w.ran(opener(platform, claudeLink(a.localId!), CLAUDE_APP))
    // Never inside the command that opened it: the app resumes it after.
    expect(w.started()).toEqual([])
    await later(OPEN_MS - 1)
    expect(w.started()).toEqual([])
    await later(1)
    expect(w.started()).toEqual([a.id])
    expect(machine.owners.get(a.id)).toMatchObject({ engine: 'claude', cwd: a.cwd })
    // As the real app resumes it, the session's Claude Code runs the mod, which holds its inbox poll open.
    expect(w.polls.map((p) => p.sessionId)).toEqual([a.id])
    w.ran(opener(platform, codexLink(t1.id), CHATGPT_APP))
    await later()
    expect(w.started()).toEqual([a.id, t1.id])
    expect(w.polls).toHaveLength(1)
  })

  it('a link for another session starts nothing, and one the scenario has not shows nothing', async () => {
    const w = fakeWorld('darwin', { front: 'chatgpt' })
    const others = [
      // Not one the app can resume.
      claudeLink(b.localId!), codexLink(t2.id),
      // Only probes name the ghost.
      claudeLink(z.localId!),
      // A session the scenario does not have, and one app's id in the other's link.
      claudeLink('local_00000000-0000-4000-9000-00000000ffff'), codexLink(a.id), claudeLink(t1.id),
      // More than the link the devices make.
      `${claudeLink(a.localId!)}&eval=1`, `${codexLink(t1.id)}/eval`,
    ]
    for (const link of others) expect(w.ran(opener('darwin', link, CLAUDE_APP))).toBeUndefined()
    // A command that opens no link.
    expect(w.ran(['/usr/bin/xdg-mime', 'query', 'default', 'x-scheme-handler/claude'])).toBeUndefined()
    expect(w.ran(['/usr/bin/open', '-b', CLAUDE_APP])).toBeUndefined()
    await later()
    expect(w.told).toEqual([])
    expect(machine.processes.size).toBe(0)
    // Only the two sessions the scenario has and the apps can open are shown.
    expect(w.shown).toEqual({ attached: [b.id], titles: ['Eval T2'] })
  })

  it("the app shows what a link opens: the Claude app's mod says its attach, the ChatGPT app's window its Codex name", async () => {
    const w = fakeWorld('darwin', { front: 'chatgpt' })
    w.codexHome.name(t2.id, 'Eval Renamed')
    w.ran(opener('darwin', claudeLink(b.localId!), CLAUDE_APP))
    w.ran(opener('darwin', codexLink(t2.id), CHATGPT_APP))
    expect(w.shown).toEqual({ attached: [], titles: [] })
    await later()
    expect(w.shown).toEqual({ attached: [b.id], titles: ['Eval Renamed'] })
    expect(w.gaps).toEqual([])
  })

  it("the ChatGPT app's title reaches the watch only from the front, and never without Accessibility (X3)", async () => {
    const behind = fakeWorld('darwin', { front: 'claude' })
    behind.ran(opener('darwin', codexLink(t2.id), CHATGPT_APP))
    await later()
    expect(behind.shown.titles).toEqual([])
    const x3 = fakeWorld('darwin', { front: 'chatgpt', of: { ...scenario, id: 'X3' } })
    x3.ran(opener('darwin', codexLink(t2.id), CHATGPT_APP))
    await later()
    expect(x3.shown.titles).toEqual([])
  })
})
