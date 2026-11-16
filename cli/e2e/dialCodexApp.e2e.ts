/**
 * The Codex app has a page of its own on the dial (docs/plans/2026-11-16-dial-codex-app-plan.md), on the real daemon: a
 * Codex session whose own hook names the Codex app (harness/codexOutside.ts) is listed on a fake dial on the desk under
 * "ChatGPT", its row's host the app. The real Codex app and a real Codex session never run. Nothing here sends a tap
 * (`agent.open`) or a rest (`focus`) from the dial, and no `harness hardware watch` puts an app in front, so nothing can
 * reach `/usr/bin/open`. A link that works logs nothing, so the log holds only that no fallback and no swipe ran.
 */
import type { ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { CodexOutside } from './harness/codexOutside.js'
import { IsolatedDaemon } from './harness/daemon.js'
import { Desk } from './harness/desk.js'

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const CODEX_APP = 'com.openai.codex'

describe('the Codex app has a page on the dial', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  /** A daemon of its own and a dial on the desk that holds one app's ring, shown its first list. */
  const fresh = async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return { d, dial }
  }

  it('a Codex session whose hook names the Codex app is on a "ChatGPT" page, and nothing is opened', async () => {
    const { d, dial } = await fresh()
    const codex = new CodexOutside(d, 'api', children, { __CFBundleIdentifier: CODEX_APP })
    const since = dial.messages.length
    await codex.hook('SessionStart', { source: 'startup' })

    await dial.next((m) => m.t === 'apps' && m.shown === 'codex'
      && (m.apps as Array<{ id: string; name: string; count: number }>).some((app) => app.id === 'codex' && app.name === 'ChatGPT' && app.count === 1),
    45_000, "the Codex app's page", since)
    await dial.next((m) => m.t === 'agent' && m.id === codex.id && m.host === 'codex', 45_000, 'the agent listed', since)

    const log = d.log()
    expect(log).not.toContain('[device] open')
    expect(log).not.toContain('[device] swipe')
    for (const secret of [codex.sessionId, CODEX_APP, 'codex://']) expect(log).not.toContain(secret)
  })
})
