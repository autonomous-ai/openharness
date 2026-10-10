/**
 * Memory, an experiment in a process of its own (services/memory.ts), on the real daemon: what another
 * machine's Memories pane asks of this one, answered by the real Memories package (store/agents/memories,
 * linked into this daemon's own Store folder) reading a made-up home.
 *
 * What it must do: no process until the first request; `memory_snapshot` answers what the agents in this
 * home remember; `memory_about_put` writes another machine's About You with its build number and never an
 * older one over a newer one; `memory_deliver` applies the person's on/off choice with its own time and
 * never an older choice over a newer one — the Claude Code hook in this home appearing and going. Killed,
 * it costs its own request alone, the core and the next request go on.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const HOST = 'memory'
const PACKAGE = fileURLToPath(new URL('../../store/agents/memories', import.meta.url))

const started = (d: IsolatedDaemon): number[] =>
  [...d.log().matchAll(new RegExp(`\\[harnessd\\] service ${HOST} started \\(pid (\\d+)\\)`, 'g'))].map((match) => Number(match[1]))

/** The hook delivery puts in Claude Code's settings in this daemon's home, or none. */
const ourHook = (home: string): boolean => {
  try {
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    return (settings.hooks?.SessionStart ?? []).some((block) => block.hooks.some((hook) => hook.command.includes('harness-memories-about-you')))
  } catch { return false }
}

describe('memory, an experiment in its own process', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('answers another machine\'s pane through the package, and never moves this machine backwards', async () => {
    // Every folder the package reads or writes, under this test's own root: a developer's shell may point
    // any of these at their real agent homes, and delivery writes About You into them (cli/AGENTS.md rule 6).
    const own = mkdtempSync(join(tmpdir(), 'memory-e2e-'))
    const homes = Object.fromEntries(['XDG_CONFIG_HOME', 'GEMINI_HOME', 'PI_HOME', 'GROK_HOME', 'HERMES_HOME', 'OPENCLAW_HOME', 'MEMORIES_HOME']
      .map((name) => [name, join(own, name.toLowerCase())]))
    const d = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', ...homes } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const home = d.env.HOME!
    // Memories, linked into this daemon's Store folder as a developer's `harness dsh install --link` would.
    mkdirSync(d.env.DSH_DIR!, { recursive: true })
    writeFileSync(join(d.env.DSH_DIR!, 'installed.json'), JSON.stringify([{ id: 'autonomous/memories', dir: PACKAGE, source: PACKAGE, ref: null, commit: null, linked: true, installedAt: 1 }]))
    // What Claude Code remembers in this home: one note about the person.
    const notes = join(home, '.claude', 'projects', '-work-app', 'memory')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'short.md'), '---\nname: short\ndescription: Wants short answers\ntype: feedback\n---\nKeep it short.\n')
    await d.start()
    const client = await LocalClient.connect(d)
    await until('the services to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    expect(started(d), 'memory no one asked for').toEqual([])

    const first = await client.request('memory_snapshot', {}, 60_000) as { snapshot: { memories: Array<{ title: string; kind: string }>; about: unknown } }
    expect(first.snapshot.memories.map((row) => [row.title, row.kind])).toEqual([['Short', 'you']])
    expect(first.snapshot.about).toBeNull()
    expect(started(d)).toHaveLength(1)

    // Another machine's About You, build 5; then an older build 3, which must not replace it.
    expect(await client.request('memory_about_put', { text: '## How you work\n- From the other machine.\n', gen: 5 }, 60_000)).toMatchObject({ ok: true })
    expect(await client.request('memory_about_put', { text: '## How you work\n- An older build.\n', gen: 3 }, 60_000)).toMatchObject({ ok: true })
    const about = (await client.request('memory_snapshot', {}, 60_000) as { snapshot: { about: { text: string; gen: number } } }).snapshot.about
    expect(about.gen).toBe(5)
    expect(about.text).toMatch(/From the other machine/)
    expect(await client.request('memory_about_put', { text: '', gen: 6 })).toMatchObject({ error: 'INVALID_MEMORY' })

    // The person's choice from another machine: on at 10, an older off at 9 ignored, off at 11 applied.
    expect(await client.request('memory_deliver', { on: true, choiceAt: 10 }, 60_000)).toMatchObject({ ok: true })
    expect(ourHook(home)).toBe(true)
    expect(await client.request('memory_deliver', { on: false, choiceAt: 9 }, 60_000)).toMatchObject({ ok: true, delivery: { ignored: true } })
    expect(ourHook(home)).toBe(true)
    expect(await client.request('memory_deliver', { on: false, choiceAt: 11 }, 60_000)).toMatchObject({ ok: true })
    expect(ourHook(home)).toBe(false)

    // Killed between requests: the next one starts it again; the core never restarts.
    const [pid] = started(d)
    process.kill(pid, 'SIGKILL')
    await until('memory to start again', async () => {
      const answer = await client.request('memory_snapshot', {}, 60_000).catch(() => null) as { snapshot?: unknown } | null
      return answer?.snapshot ? answer : null
    }, 60_000, 500)
    expect(started(d).length).toBeGreaterThanOrEqual(2)
    expect(d.coresStarted()).toBe(1)
    client.close()
  }, 180_000)
})
