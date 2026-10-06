/** Shell requests stay outside the core: authorization, literal argv, and durable launch receipts. */
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { AgentCreationReceipts, AgentCreationReceiptError, creationFingerprint, validCreationId, type AgentCreationStatus } from '../lib/agentCreationReceipt.js'
import { shellContextReply } from '../lib/shellContextReply.js'
export { SHELL_REQUESTS } from '../lib/shellProtocol.js'

export function startShell(core: CoreApi): ServiceRequests {
  const receipts = new AgentCreationReceipts(join(core.dataDir, 'shell-creations'))
  const describe = (status: AgentCreationStatus): Record<string, unknown> => {
    if (status.state !== 'created') return { ...status }
    const row = core.agents.byAgent(status.agentId)
    if (!row) return { state: 'unavailable' }
    return { state: 'created', agent: {
      id: row.agentId, sessionId: row.sessionId, engine: row.engine, name: core.agents.displayName(row),
      status: 'active', launch: row.launch, terminal: { available: core.agents.terminalAvailable(row.agentId) },
      project: { cwd: row.cwd, root: row.cwd, name: row.projectDir },
    } }
  }
  const guarded = (run: () => Record<string, unknown> | Promise<Record<string, unknown>>) =>
    Promise.resolve().then(run).catch((error: unknown) => {
      if (error instanceof AgentCreationReceiptError) return { error: error.code }
      throw error // The service host isolates unexpected failures from the core.
    })
  return {
    shell_capabilities: (_, asker) => asker.owner ? { protocol: 1 } : { error: 'OWNER_REQUIRED' },
    shell_context_reply: (payload, asker) => asker.owner ? { ok: shellContextReply(payload) } : { error: 'OWNER_REQUIRED' },
    shell_open_status: (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      if (!validCreationId(payload.creationId)) return { error: 'INVALID_CREATION_ID' }
      return guarded(() => ({ creationId: payload.creationId, ...describe(receipts.status(payload.creationId as string)) }))
    },
    shell_open: (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      const { argv, cwd, creationId } = payload
      if (!validCreationId(creationId)) return { error: 'INVALID_CREATION_ID' }
      // Do not turn a string into a program. All arguments, including punctuation and spaces, stay literal.
      if (payload.command !== undefined || !Array.isArray(argv) || argv.length === 0 || argv.length > 256
        || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !argv[0]
        || Buffer.byteLength(JSON.stringify(argv)) > 32 * 1024) return { error: 'INVALID_ARGV' }
      if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0') || Buffer.byteLength(cwd) > 4096) return { error: 'INVALID_CWD' }
      const request = { argv: [...argv] as string[], cwd }
      return guarded(async () => {
        const status = await receipts.run(creationId, creationFingerprint(request), async () => {
          // Filesystem providers can stall; a stalled path must not hold a launch indefinitely.
          let timer: ReturnType<typeof setTimeout> | undefined
          const directory = await Promise.race([
            stat(cwd).then(s => s.isDirectory(), () => false),
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 4000) }),
          ]).finally(() => clearTimeout(timer))
          if (!directory) return { state: 'failed', error: 'CWD_NOT_FOUND' }
          const opened = await core.terminals.open(request)
          return opened.ok ? { state: 'created', agentId: opened.agentId } : { state: 'failed', error: opened.error, detail: opened.detail }
        })
        return { creationId, ...describe(status) }
      })
    },
  }
}
