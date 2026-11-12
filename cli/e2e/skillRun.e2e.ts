/**
 * `harness delete` on the real daemon (docs/plans/2026-11-12-skill-run-isolation-design.md): a run's
 * words, saved while it ran, are gone from the daemon's data folder once the person deletes it, closed or running.
 * Signed out, from a terminal, with the fake Claude Code (harness/fakeEngine.mjs), on a daemon, data folder and tmux
 * server of its own.
 */
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

/** `harness <args>` from [pane], not a terminal, so plain text. */
function harness(d: IsolatedDaemon, pane: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: pane }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => done({ code: code ?? -1, out, err }))
  })
}

/** The files under [folder] that hold any of [words], read as bytes. The daemon's log is not there (it is the
 *  daemon's output, `d.log()`), and is checked on its own. */
function wordsUnder(folder: string, words: string[]): string[] {
  const held: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        let bytes: Buffer
        // A file the daemon removes between the listing and the read holds nothing.
        try { bytes = readFileSync(path) } catch { continue }
        if (words.some((word) => bytes.includes(word))) held.push(path)
      }
    }
  }
  walk(folder)
  return held
}

describe('harness delete, end to end', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const started = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it('the person starts a harness with a task, closes it and deletes it: none of its words are left in the daemon\'s folder', async () => {
    const d = await started()
    const task = 'email zanzibarquokka about the dentist'
    const words = ['zanzibarquokka', 'dentist']
    const made = await harness(d, '', ['new', 'claude', '--name', 'run-1', '--', task])
    expect(made.code, made.out + made.err).toBe(0)
    const waited = await harness(d, '', ['wait', 'run-1', '--timeout', '90s'])
    expect(waited.code, waited.out + waited.err).toBe(0)
    const closed = await harness(d, '', ['close', 'run-1'])
    expect(closed.code, closed.out + closed.err).toBe(0)
    // Saved before the delete.
    expect(wordsUnder(d.dataDir, words)).not.toEqual([])

    const deleted = await harness(d, '', ['delete', 'run-1', '--json'])
    expect(deleted.code, deleted.out + deleted.err).toBe(0)
    expect(JSON.parse(deleted.out)).toMatchObject({ name: 'run-1', deleted: true, kept: [] })
    // The search process forgets when told, not in the same breath.
    await until('no word of run-1 left', () => wordsUnder(d.dataDir, words).length === 0, 30_000, 200)
    expect(d.log()).not.toContain('zanzibarquokka')
    expect((await harness(d, '', ['ps', '--all'])).out).not.toContain('run-1')
    // Gone: no harness by that name.
    expect((await harness(d, '', ['delete', 'run-1'])).code).toBe(1)
  })

  it('a running harness is deleted in one step', async () => {
    const d = await started()
    const task = 'book the quetzalpangolin vet for tuesday'
    const words = ['quetzalpangolin']
    const made = await harness(d, '', ['new', 'claude', '--name', 'run-2', '--', task])
    expect(made.code, made.out + made.err).toBe(0)
    const waited = await harness(d, '', ['wait', 'run-2', '--timeout', '90s'])
    expect(waited.code, waited.out + waited.err).toBe(0)
    const client = await LocalClient.connect(d)
    const row = (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents.find((a) => a.name === 'run-2')
    client.close()
    expect(row?.tmuxPane, JSON.stringify(row)).toBeTruthy()
    expect(wordsUnder(d.dataDir, words)).not.toEqual([])

    const deleted = await harness(d, '', ['delete', 'run-2'])
    expect(deleted.code, deleted.out + deleted.err).toBe(0)
    await until('no word of run-2 left', () => wordsUnder(d.dataDir, words).length === 0, 30_000, 200)
    expect(d.log()).not.toContain('quetzalpangolin')
    const panes = (await d.tmux.run('list-panes', '-a', '-F', '#{pane_id}').catch(() => '')).split('\n')
    expect(panes).not.toContain(String(row!.tmuxPane))
    expect((await harness(d, '', ['ps', '--all'])).out).not.toContain('run-2')
  })
})
