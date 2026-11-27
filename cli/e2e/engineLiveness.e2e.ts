import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, SOURCES_CLI, until } from './harness/daemon.js'
import { fakeOpenclawScript } from './harness/fakeOpenclaw.mjs'

it.runIf(['darwin', 'linux'].includes(process.platform))('reports an exited engine before discovery retires its shell pane (#4493)', async () => {
  const daemon = await IsolatedDaemon.create()
  try {
    const steps = join(daemon.root, 'openclaw-steps.jsonl')
    const project = join(daemon.projectsDir, 'oc')
    mkdirSync(project, { recursive: true })
    writeFileSync(steps, '')
    daemon.env.OPENCLAW_PATH = join(daemon.root, 'bin', 'openclaw')
    daemon.env.OPENCLAW_STATE_DIR = join(daemon.root, 'openclaw')
    writeFileSync(daemon.env.OPENCLAW_PATH, fakeOpenclawScript({ steps, events: join(daemon.root, 'events.jsonl') }), { mode: 0o755 })
    await daemon.start()
    const name = 'x'
    const entry = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : SOURCES_CLI
    const run = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
      execFile(process.execPath, [...entry, ...args], { cwd: CLI_ROOT, env: { ...daemon.env, TMUX_PANE: '' } },
        (error, out, err) => {
          if (!error || typeof error.code === 'number') resolve({ code: error?.code as number ?? 0, out, err })
          else reject(error)
        })
    })
    const made = await run('new', 'openclaw', '--name', name, project, '--', 'Say hello before exiting')
    expect(made.code, made.out + made.err).toBe(0)
    const answered = await run('wait', name, '--timeout', '1m')
    expect(answered.code, answered.out + answered.err).toBe(0)
    const client = await LocalClient.connect(daemon)
    try {
      const paneOf = async () => {
        const list = await client.request<{ agents: Array<{ name: string; tmuxPane: string }> }>('agents_list', {})
        return list.agents.find(a => a.name === name)?.tmuxPane
      }
      const pane = await paneOf()
      expect(pane).toMatch(/^%\d+$/)
      const state = async () => {
        const [show, ps] = await Promise.all([run('show', name, '--json'), run('ps', '--json')])
        expect(show.code, show.out + show.err).toBe(0)
        expect(ps.code, ps.out + ps.err).toBe(0)
        const rows = JSON.parse(ps.out).harnesses as Array<{ name: string; state: string }>
        return [JSON.parse(show.out).state, rows.find(a => a.name === name)?.state]
      }
      expect(await state()).toEqual(['idle', 'idle'])

      // The daemon can still reach tmux when its process probes fail. Its own PATH keeps the outage in this fixture.
      const ps = join(daemon.root, 'bin', 'ps')
      writeFileSync(ps, '#!/bin/sh\ncase "$1" in -axo|-p) exit 91;; esac\nexec /bin/ps "$@"\n', { mode: 0o755 })
      const [unreadable, pending] = await Promise.all([state(), run('wait', name, '--timeout', '2s')])
      expect.soft(unreadable).toEqual(['unknown', 'unknown'])
      expect.soft(pending.code, pending.out + pending.err).toBe(124)

      // Now only discovery's full-machine census fails, as it did under load in #4493.
      writeFileSync(ps, '#!/bin/sh\n[ "$1" = -axo ] && exit 91\nexec /bin/ps "$@"\n')
      appendFileSync(steps, '{"exit":0}\n')
      await until('the exited engine hands its pane to the shell', async () =>
        (await daemon.tmux.run('capture-pane', '-pt', pane!)).includes('This pane is a shell now') || null, 10_000, 100)
      expect(await paneOf()).toBe(pane)
      const [stopped, waited] = await Promise.all([state(), run('wait', name, '--json', '--timeout', '5s')])
      expect.soft(stopped).toEqual(['stopped', 'stopped'])
      expect.soft(waited.code, waited.out + waited.err).toBe(4)
      expect.soft(JSON.parse(waited.out).harnesses?.[0]?.state).toBe('stopped')
      expect(await paneOf()).toBe(pane)
    } finally { client.close() }
  } finally { await daemon.close() }
}, 180_000)
