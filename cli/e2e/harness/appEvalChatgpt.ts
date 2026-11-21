// Tier B's steps on the ChatGPT app's threads (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier B"): none is built
// yet, so a ChatGPT scenario is skipped at its first.
import { notBuilt, type AppSteps } from './appEvalDriver.js'

export const chatgptSteps: AppSteps = {
  'claude.write': notBuilt('claude.write'),
  'codex.write': notBuilt('codex.write'),
  hook: notBuilt('hook'),
  attach: notBuilt('attach'),
  voice: notBuilt('voice'),
  quit: notBuilt('quit'),
  relaunch: notBuilt('relaunch'),
}
