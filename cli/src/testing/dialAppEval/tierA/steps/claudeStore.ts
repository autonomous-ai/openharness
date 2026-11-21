// Tier A's steps on the Claude app's store: what the app writes as its sessions change.
import type { StepHandler } from '../world.js'

export const claudeStoreSteps: { 'claude.write': StepHandler<'claude.write'> } = {
  /** Each session's file written as the app writes it, last active `ageMs` ago and written now, then the store's watch
   *  told of each file, as fs.watch tells the app's own writes. */
  'claude.write': async (world, step) => {
    const now = Date.now()
    const written = step.sessions.map((key) => {
      const s = world.session(key)
      if (!s.localId) throw new Error(`scenario ${world.scenario.id}: Claude session ${key} has no localId`)
      return world.claudeStore.write({ localId: s.localId, cliSessionId: s.id, cwd: s.cwd, title: s.title,
        lastActivityAt: now - s.ageMs, isArchived: step.archived === true }, { mtime: now })
    })
    for (const path of written) world.storeChanged(path)
  },
}
