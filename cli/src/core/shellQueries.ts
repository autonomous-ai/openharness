/** Only the shell service may ask for these operations. Live identity and pane launch stay here. */
import type { CoreApi } from './api.js'
import { terminalOpenError } from '../lib/shellProtocol.js'

export async function answerShellQuery(core: Pick<CoreApi, 'terminals'>, query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (query === 'open') {
    const invalid = terminalOpenError(payload)
    if (invalid) return { ok: false, error: invalid }
    return core.terminals.open({ argv: [...payload.argv as string[]], cwd: payload.cwd as string })
  }
  if (query === 'describe' || query === 'visitStatus') {
    if (typeof payload.agentId !== 'string' || !payload.agentId || payload.agentId.length > 256) return { error: 'BAD_QUERY' }
    return query === 'describe' ? { agent: await core.terminals.describe(payload.agentId) } : core.terminals.visitStatus(payload.agentId)
  }
  return { error: 'UNKNOWN_QUERY' }
}
