// Tier A's steps on the ChatGPT app's Codex home: its threads, its sidebar and Codex's names.
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import type { CodexAppFixture } from '../../../codexAppFixture.js'
import type { SessionKey } from '../../types.js'
import type { StepHandler } from '../world.js'

/** The threads Codex has named in each home: it names a thread once, so a later write of its row keeps its name. */
const named = new WeakMap<CodexAppFixture, Set<string>>()

export const codexStoreSteps: { 'codex.write': StepHandler<'codex.write'> } = {
  /**
   * The rows of `sessions` and `archived` written as the app writes them, last active their age (or `ages`) ago; the
   * sidebar's projects in `projects` order with each session's project; Codex's name of each thread it has not named
   * yet, then `names`, which may rename a thread the step writes no row of. Then the store's watch is told of each file.
   */
  'codex.write': async (world, step) => {
    const home = world.codexHome
    const now = Date.now()
    const written: string[] = []
    const keys = [...new Set([...step.sessions, ...step.archived ?? []])]
    if (keys.length > 0) {
      const archived = new Set(step.archived)
      home.threads(keys.map((key) => {
        const s = world.session(key)
        return { id: s.id, cwd: s.cwd, source: s.cli ? 'cli' : 'vscode', archived: archived.has(key) ? 1 : 0,
          recencyAtMs: now - (step.ages?.[key] ?? s.ageMs) }
      }))
      written.push(join(home.home, 'state_5.sqlite'))
    }
    if (step.projects) {
      const assignments = Object.fromEntries(world.scenario.sessions.filter((s) => s.project !== undefined)
        .map((s) => [s.id, { projectKind: 'local', projectId: s.project }]))
      home.state({ projectOrder: step.projects, assignments })
      written.push(join(home.home, '.codex-global-state.json'))
    }
    const done = named.get(home) ?? new Set<string>()
    named.set(home, done)
    const names: Array<[SessionKey, string]> = [
      ...step.sessions.filter((key) => !done.has(world.session(key).id)).map((key): [SessionKey, string] => [key, world.session(key).title]),
      ...Object.entries(step.names ?? {}),
    ]
    for (const [key, name] of names) {
      const { id } = world.session(key)
      home.name(id, name)
      done.add(id)
    }
    if (names.length > 0) written.push(join(home.home, 'session_index.jsonl'))
    if (step.walBusy) {
      // The app's own writer, open with a write of its rows in the WAL, as while it runs: the reader reads past it.
      // The world has no stop of its own to hang its close on: it closes when the test that runs the scenario ends.
      const writer = home.writer()
      onTestFinished(() => writer.close())
      writer.exec('UPDATE threads SET recency_at_ms = recency_at_ms')
      written.push(join(home.home, 'state_5.sqlite-wal'))
    }
    for (const path of written) world.storeChanged(path)
  },
}
