/** Shell requests stay outside the core: authorization, literal argv, and durable launch receipts. */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { AgentCreationReceipts, AgentCreationReceiptError, creationFingerprint, validCreationId, type AgentCreationStatus } from '../lib/agentCreationReceipt.js'
import { shellContextReply } from '../lib/shellContextReply.js'
import { terminalOpenError } from '../lib/shellProtocol.js'
export { SHELL_REQUESTS } from '../lib/shellProtocol.js'

export function startShell(core: CoreApi): ServiceRequests {
  const receipts = new AgentCreationReceipts(join(core.dataDir, 'shell-creations'))
  const visits = new Map<string, Promise<Record<string, unknown>>>()
  const describe = async (status: AgentCreationStatus): Promise<Record<string, unknown>> => {
    if (status.state !== 'created') return { ...status }
    const agent = await core.terminals.describe(status.agentId)
    return agent ? { state: 'created', agent } : { state: 'unavailable' }
  }
  const guarded = (run: () => Record<string, unknown> | Promise<Record<string, unknown>>) =>
    Promise.resolve().then(run).catch((error: unknown) => {
      if (error instanceof AgentCreationReceiptError) return { error: error.code }
      throw error // The service host isolates unexpected failures from the core.
    })
  return {
    shell_capabilities: (_, asker) => asker.owner ? { protocol: 1 } : { error: 'OWNER_REQUIRED' },
    shell_context_reply: (payload, asker) => asker.owner ? { ok: shellContextReply(payload) } : { error: 'OWNER_REQUIRED' },
    shell_visit_status: (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      if (typeof payload.agentId !== 'string' || !payload.agentId || payload.agentId.length > 256) return { error: 'INVALID_AGENT_ID' }
      const id = payload.agentId
      if (!visits.has(id)) visits.set(id, core.terminals.visitStatus(id).finally(() => visits.delete(id)))
      return visits.get(id)!
    },
    shell_open_status: (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      if (!validCreationId(payload.creationId)) return { error: 'INVALID_CREATION_ID' }
      return guarded(async () => ({ creationId: payload.creationId, ...await describe(receipts.status(payload.creationId as string)) }))
    },
    shell_open: (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      const { argv, cwd, creationId } = payload
      if (!validCreationId(creationId)) return { error: 'INVALID_CREATION_ID' }
      const invalid = terminalOpenError(payload)
      if (invalid) return { error: invalid }
      const request = { argv: [...argv as string[]], cwd: cwd as string }
      return guarded(async () => {
        const status = await receipts.run(creationId, creationFingerprint(request), async () => {
          // Filesystem providers can stall; a stalled path must not hold a launch indefinitely.
          let timer: ReturnType<typeof setTimeout> | undefined
          const directory = await Promise.race([
            stat(request.cwd).then(s => s.isDirectory(), () => false),
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 4000) }),
          ]).finally(() => clearTimeout(timer))
          if (!directory) return { state: 'failed', error: 'CWD_NOT_FOUND' }
          const opened = await core.terminals.open(request)
          return opened.ok ? { state: 'created', agentId: opened.agentId } : { state: 'failed', error: opened.error, detail: opened.detail }
        })
        return { creationId, ...await describe(status) }
      })
    },
  }
}
