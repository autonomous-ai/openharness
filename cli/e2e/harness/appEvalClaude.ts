// Tier B's steps on the Claude app's sessions (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier B"): its store,
// written in the daemon's throwaway home as the app writes it (src/testing/claudeAppFixture.ts).
import { claudeStoreRoots } from '../../src/cable/hosts/appPlaces.js'
import { claudeAppFixture } from '../../src/testing/claudeAppFixture.js'
import { notBuilt, type AppSteps } from './appEvalDriver.js'

export const claudeSteps: AppSteps = {
  /** Each session's file written as the app writes it, last active `ageMs` ago and written now. */
  'claude.write': async (world, step) => {
    const now = Date.now()
    const store = claudeAppFixture(claudeStoreRoots(world.platform, world.d.env, world.d.env.HOME!)[0]!.root)
    for (const key of step.sessions) {
      const s = world.session(key)
      if (!s.localId) throw new Error(`scenario ${world.scenario.id}: Claude session ${key} has no localId`)
      store.write({ localId: s.localId, cliSessionId: s.id, cwd: s.cwd, title: s.title, lastActivityAt: now - s.ageMs,
        isArchived: step.archived === true }, { mtime: now })
    }
  },
  'codex.write': notBuilt('codex.write'),
  hook: notBuilt('hook'),
  attach: notBuilt('attach'),
  voice: notBuilt('voice'),
  quit: notBuilt('quit'),
  relaunch: notBuilt('relaunch'),
}
