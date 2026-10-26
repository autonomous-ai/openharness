import type { FastifyRequest } from 'fastify'
import type { Machine, Prisma } from '@prisma/client'
import { machineAlive, prisma } from './prisma.js'
import { machineBillingAllowsDataPlane } from './billingState.js'
import { AppError } from '../errors/index.js'
import type { AuthUser } from './ssoAuth.js'

/**
 * Team sessions (docs/plans/2026-10-24-swarm-team-account.md, Task 1).
 *
 * Teammates' Swarm agents run on a person's Mac inside a separate standard macOS user, whose own Harness daemon signs
 * in to the person's account. With a computer's sign-in that daemon could reach the person's other machines through
 * the relay (`harness ps --machine …`, `harness show`, `harness new` there), read the account over REST and act in a
 * Swarm as the person. So it signs in with a TEAM session instead (lib/harnessSession.ts): minted only by one of the
 * account's computers, bound to the computer that redeemed it, and able to do strictly less than a computer.
 *
 * Every limit is the server's; none relies on the CLI behaving:
 *  - Authentication (lib/ssoAuth.ts) refuses a team session unless the caller passes `allowTeamSession`, and only two
 *    callers do: the REST gate below and the machine socket. So the web relay (`machine_select` and attach,
 *    lib/webWs.ts), the device lane (lib/deviceWs.ts), Agent Messages (lib/agentMessagesWs.ts), the observer socket
 *    (lib/observerWs.ts) and the phone's routes refuse it, and so will any socket added later.
 *  - REST (`teamRequestAllowed`, run by middlewares/authMiddleware.ts for every team request): deny by default.
 *    TEAM_ROUTES is the whole list; a route whose path names a machine must name this session's own.
 *  - The machine socket (lib/adapterWs.ts): only as its own computer's machine, and only while that row is marked
 *    `team` (`Machine.sessionKind`). It hears only device-key pushes, never the account's grid name, raises no pairing
 *    notice on the person's apps, and may take only its own key off the device key log (lib/deviceKeyLog.ts).
 *  - The Super Tab store (superTabs/store.ts, native.ts): never the person; as an agent only one running on its own
 *    machine; host routes only for its own machine; no machine contribution, pause or removal; and no command that
 *    starts, adds, moves or drives an agent on another machine.
 *
 * The other direction stays open: the person's own apps select the team machine like any of theirs, and Swarm members'
 * read-only views of its agents reach it through the shares its daemon publishes (routes/harnessShares.ts).
 */

export const TEAM_SESSION_LIMITED = 'TEAM_SESSION_LIMITED'
export const TEAM_SESSION_MESSAGE = 'A team sign-in can only run Swarm agents on its own machine.'

/**
 * A computer turning ITSELF into a team machine (`harness team on`, a machine used only for agents) keeps its computer
 * id, so its Swarm contributions and history survive. Only that computer may ask (routes/auth.ts): its own Harness
 * computer session, or any sign-in of the account carrying this message signed by the computer's machine key on the
 * account's device key log (lib/deviceKeyLog.ts) — what an Autonomous sign-in, which names no computer, can show.
 * The signature is ed25519 over these UTF-8 bytes, base64; `at` is milliseconds since the epoch.
 */
export function teamConversionMessage(userId: string, computerId: string, machineId: string, at: number): string {
  return `harness team conversion v1\n${userId}\n${computerId}\n${machineId}\n${at}`
}
/** How far a conversion proof's `at` may be from the server's clock, either way. A proof is good once. */
export const TEAM_CONVERSION_PROOF_MS = 5 * 60_000
/** Sent down to a machine its computer just converted: a socket still connected under the old sign-in closes. */
export const TEAM_CONVERTED_FRAME = '__team_converted'

export function isTeamSession(user: Pick<AuthUser, 'harnessSessionKind'> | null | undefined): boolean {
  return user?.harnessSessionKind === 'team'
}

type MachineReader = Pick<Prisma.TransactionClient, 'machine'>

/**
 * The machine a team session acts for: the account's live remote machine for the session's computer. Null for any
 * other session, and while there is none to act for — not registered yet, removed from the account, unpaid, or any
 * live row for that computer held by a normal sign-in (which would make it the person's machine, not a team one).
 */
export async function teamMachine(user: AuthUser, db: MachineReader = prisma): Promise<Machine | null> {
  if (!isTeamSession(user) || !user.harnessComputerId) return null
  const rows = await db.machine.findMany({
    where: { userId: user.sub, computerId: user.harnessComputerId, authMode: 'remote', autonomousEnv: user.autonomousEnv, ...machineAlive },
    orderBy: { createdAt: 'asc' },
  })
  if (rows.some(row => row.sessionKind !== 'team')) return null
  return rows.find(row => machineBillingAllowsDataPlane(row)) ?? null
}

/** For a handler that serves a team session too: null for any other session, else the id of the machine it acts for.
 *  A team session with no machine to act for is refused. */
export async function teamMachineScope(user: AuthUser, db: MachineReader = prisma): Promise<string | null> {
  if (!isTeamSession(user)) return null
  const machine = await teamMachine(user, db)
  if (!machine) throw new AppError(TEAM_SESSION_MESSAGE, 403, TEAM_SESSION_LIMITED)
  return machine.machineId
}

/**
 * How a route on the list is held to the session's machine:
 *  - `open`: needs no machine yet (reading the device keys, registering its own computer — whose handler checks it);
 *  - `machine`: the path's `:machineId` must be its machine;
 *  - `agent`: speaks as one of its agents, so `asAgentId` is required; the store checks that agent runs on its machine;
 *  - `bound`: its machine must exist; the handler or store checks what the body or path names against it.
 */
export type TeamRouteScope = 'open' | 'machine' | 'agent' | 'bound'
export interface TeamRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  scope: TeamRouteScope
  /** The body names a machine (`machineId`): it must name this session's own, checked once the body is read. */
  bodyMachine?: true
}

/** Everything a team daemon may call over REST: what it needs to run its own machine and host Swarm agents there. Sign-in
 *  renewal and sign-out (`/api/auth/refresh`, `/api/auth/revoke`) take the refresh token, not a session, and are open
 *  to every session already. Anything else answers 403 `TEAM_SESSION_LIMITED`. Pinned to the route table by a test. */
export const TEAM_ROUTES: readonly TeamRoute[] = [
  // Its own machine: registered before its socket dials, and the account's device keys, which say whom to let in.
  { method: 'POST', url: '/api/machines/resolve-computer', scope: 'open' },
  { method: 'GET', url: '/api/device-keys', scope: 'open' },
  // The Swarm host loop for its machine.
  { method: 'GET', url: '/api/super-tabs/hosts/:machineId', scope: 'machine' },
  { method: 'GET', url: '/api/super-tabs/hosts/:machineId/pools', scope: 'machine' },
  { method: 'GET', url: '/api/super-tabs/hosts/:machineId/assignments', scope: 'machine' },
  // The host loop by parts (docs/design/2026-10-26-swarm-state-parts.md 4.10). The three reads above answer 426 now; they
  // stay listed so an old team daemon is told to update rather than refused.
  { method: 'GET', url: '/api/super-tabs/hosts/:machineId/changes', scope: 'machine' },
  // The same read with the etags the host holds, in a body (too many for a URL).
  { method: 'POST', url: '/api/super-tabs/hosts/:machineId/changes', scope: 'machine' },
  { method: 'POST', url: '/api/super-tabs/hosts/:machineId/terminal', scope: 'machine' },
  { method: 'GET', url: '/api/super-tabs/hosts/:machineId/starts/:tabId/:startId', scope: 'machine' },
  { method: 'POST', url: '/api/super-tabs/hosts/:machineId/starts/:tabId/:startId', scope: 'machine' },
  // A read-only token for a queued start's repository, to clone and fetch its folder before the agent exists: a team account
  // has no git login of its own (routes/superTabs.ts).
  { method: 'POST', url: '/api/super-tabs/hosts/:machineId/starts/:tabId/:startId/github-token', scope: 'machine' },
  { method: 'POST', url: '/api/super-tabs/:tabId/machines/:machineId', scope: 'machine' },
  // Reads as one of its agents.
  { method: 'GET', url: '/api/super-tabs/:tabId', scope: 'agent' },
  { method: 'GET', url: '/api/super-tabs/:tabId/parts', scope: 'agent' },
  { method: 'GET', url: '/api/super-tabs/:tabId/changes', scope: 'agent' },
  { method: 'GET', url: '/api/super-tabs/:tabId/groups', scope: 'agent' },
  { method: 'GET', url: '/api/super-tabs/:tabId/groups/:conversationId', scope: 'agent' },
  { method: 'GET', url: '/api/super-tabs/:tabId/starts/:startId', scope: 'agent' },
  { method: 'GET', url: '/api/super-tabs/:tabId/routing-policy', scope: 'agent' },
  { method: 'GET', url: '/api/super-tabs/:tabId/route-decisions', scope: 'agent' },
  { method: 'GET', url: '/api/super-tabs/:tabId/route-decisions/:decisionId', scope: 'agent' },
  { method: 'GET', url: '/api/super-tabs/:tabId/conversations/:conversationId/messages', scope: 'agent' },
  { method: 'GET', url: '/api/super-tabs/:tabId/conversations/:conversationId/attempts', scope: 'agent' },
  { method: 'GET', url: '/api/super-tabs/:tabId/terminal/:requestId', scope: 'agent' },
  { method: 'POST', url: '/api/super-tabs/:tabId/attachments', scope: 'agent' },
  // Its agent's one-hour GitHub token for the repository of its task (Task 4); the body's machine must be its own.
  { method: 'POST', url: '/api/super-tabs/:tabId/github-token', scope: 'agent', bodyMachine: true },
  // Commands as one of its agents, its agents' deliveries, stops and native terminals, its agents' role texts.
  { method: 'POST', url: '/api/super-tabs/:tabId/commands', scope: 'bound' },
  { method: 'GET', url: '/api/super-tabs/:tabId/agents/:agentId/deliveries', scope: 'bound' },
  { method: 'GET', url: '/api/super-tabs/:tabId/agents/:agentId/deliveries/:deliveryId', scope: 'bound' },
  { method: 'POST', url: '/api/super-tabs/:tabId/agents/:agentId/deliveries/:deliveryId', scope: 'bound' },
  { method: 'POST', url: '/api/super-tabs/:tabId/stopped', scope: 'bound' },
  { method: 'GET', url: '/api/super-tabs/:tabId/native/:contextId', scope: 'bound' },
  { method: 'POST', url: '/api/super-tabs/:tabId/native/:contextId', scope: 'bound' },
  { method: 'GET', url: '/api/super-tabs/:tabId/projects/:projectId/roles/:roleId', scope: 'bound' },
  // Swarm members' read-only views of its agents: shares of its own harnesses, for a Swarm only.
  { method: 'PUT', url: '/api/harness-shares/:id', scope: 'bound' },
  { method: 'DELETE', url: '/api/harness-shares/:id', scope: 'bound' },
]

/** The matched route's entry on TEAM_ROUTES: by the route, not the raw URL, so an encoded spelling is the same route. */
function teamRoute(request: FastifyRequest): TeamRoute | undefined {
  const url = request.routeOptions?.url
  return url ? TEAM_ROUTES.find(r => r.method === request.method && r.url === url) : undefined
}

/** The machine each admitted team request acts for, kept for the check that runs once its body is read. */
const admitted = new WeakMap<FastifyRequest, string>()

/** Whether a team session may make this request: its matched route is on TEAM_ROUTES and holds to its machine. */
export async function teamRequestAllowed(request: FastifyRequest, user: AuthUser): Promise<boolean> {
  const rule = teamRoute(request)
  if (!rule) return false
  if (rule.scope === 'open') return true
  const machine = await teamMachine(user)
  if (!machine) return false
  admitted.set(request, machine.machineId)
  if (rule.scope === 'machine') return (request.params as { machineId?: unknown } | undefined)?.machineId === machine.machineId
  if (rule.scope === 'agent') {
    const asAgentId = (request.query as { asAgentId?: unknown } | undefined)?.asAgentId
    return typeof asAgentId === 'string' && asAgentId.length > 0
  }
  return true
}

/** Once the body is read (a preHandler, middlewares/authMiddleware.ts): a route whose body names a machine must name
 *  the one this team session acts for, whatever the route itself then checks. */
export function teamBodyAllowed(request: FastifyRequest): boolean {
  if (!teamRoute(request)?.bodyMachine) return true
  const machineId = (request.body as { machineId?: unknown } | null | undefined)?.machineId
  return typeof machineId === 'string' && machineId === admitted.get(request)
}
