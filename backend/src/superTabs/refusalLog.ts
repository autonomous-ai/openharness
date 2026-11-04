import { clientKind } from '../lib/routeLatency.js'

/** What a client declares itself on an HTTP request (`x-harness-client: cli/0.5.34`; the CLI sends it since #2675, as its
 *  sockets declare `?client=&v=`, lib/wsAttribution.ts). Believed only in its own shape, so a header never writes into the
 *  log; otherwise the kind is the user agent's (lib/routeLatency.ts) and the version unknown. */
export interface DeclaredClient { kind: string; version: string | null }
const DECLARED = /^(cli|desktop|phone|web)\/([0-9A-Za-z.+-]{1,32})$/

export function declaredHttpClient(headers: Record<string, string | string[] | undefined>): DeclaredClient {
  const declared = headers['x-harness-client']
  const match = typeof declared === 'string' ? DECLARED.exec(declared) : null
  if (match) return { kind: match[1]!, version: match[2]! }
  const agent = headers['user-agent']
  return { kind: clientKind(typeof agent === 'string' ? agent : undefined, false), version: null }
}

/** The 'Swarm command refused' line (Ken's prod scan, 11-04: 615 refusals in 32 minutes that nobody could attribute): its
 *  code and type as before, the Swarm, the agent the command names or else acts as, whether it acts as one, the client and
 *  its version, and a host route's machine. Never what the command says: no text, conversation, recipient or email. */
export function refusalLogFields(tabId: string, command: { type: string; agentId?: unknown }, code: string,
  from: { asAgentId?: string; client?: DeclaredClient; machineId?: string } = {}): Record<string, unknown> {
  const named = typeof command.agentId === 'string' ? command.agentId : undefined
  return {
    code, type: command.type, tabId, agentId: named ?? from.asAgentId ?? null, asAgent: !!from.asAgentId,
    client: from.client?.kind ?? 'other', version: from.client?.version ?? null,
    ...(from.machineId ? { machineId: from.machineId } : {}),
  }
}
