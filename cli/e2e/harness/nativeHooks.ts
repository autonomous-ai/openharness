/** External CLIs snapshot hooks at launch; core readiness no longer waits for optional setup. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { until, type IsolatedDaemon } from './daemon.js'

export async function waitForNativeHooks(d: IsolatedDaemon, engine: 'claude' | 'codex'): Promise<void> {
  const home = engine === 'claude' ? d.env.CLAUDE_CONFIG_DIR || join(d.env.HOME!, '.claude') : d.env.CODEX_HOME!
  const file = join(home, engine === 'claude' ? 'settings.json' : 'hooks.json')
  await until(`${engine} startup hooks published in its private home`, () => {
    const settings = JSON.parse(readFileSync(file, 'utf8'))
    return settings.hooks?.SessionStart?.some((block: { hooks?: Array<{ type?: string; command?: string }> }) =>
      block.hooks?.some(hook => hook.type === 'command' && hook.command?.includes('notify.mjs')
        && hook.command.includes(String(d.port)))) || null
  }, 30_000, 100)
  d.assertHooksStayedInside()
}
