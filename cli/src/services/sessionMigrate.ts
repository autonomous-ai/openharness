/**
 * `agent_session_migrate`, for the phone's "Change agent": the agent's live conversation converted to the other
 * engine (Claude Code ↔ Codex, engines/migrate/) and written as a new session where that engine, launched now for a
 * new agent here, resumes it. The phone then creates the agent with `resumeSessionId`, and removes the old one only
 * once the new one runs. Nothing of the source is changed. Unlike the handoff file it carries the whole conversation:
 * the person's words, the answers, tool calls and their results, and reasoning the target engine can replay.
 *
 * It reads the person's transcripts and writes into their engine's home, so only the owner may ask. In the edge host,
 * beside the handoff, whose conversation facts (`core.conversations`) it asks the core for as it needs them.
 */
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ConversationReads } from '../core/api.js'
import { env } from '../config/env.js'
import { claudeSessionPath, codexRolloutPath, convertSession, MIGRATE_ENGINES, writeNewSessionFile, type MigrateEngine } from '../engines/migrate/session.js'
import { launchCodexHome, sessionClaudeHome } from '../lib/engineHomes.js'
import { commandOutputInInteractiveShell } from '../engines/kit/interactiveProbe.js'
import { probeEngines } from '../lib/engineProbe.js'
import { warmLoginShellEnvironment } from '../lib/loginShellEnv.js'
import { errorKind } from '../lib/log.js'
import { isSubagentTranscript } from '../lib/subagentTranscript.js'

export type MigrateCode = 'OWNER_REQUIRED' | 'MISSING_AGENT_ID' | 'BAD_ENGINE' | 'UNKNOWN_AGENT' | 'NO_SESSION' | 'TARGET_UNAVAILABLE' | 'CONVERT_FAILED' | 'TIMEOUT'

class MigrateError extends Error {
  constructor(readonly code: MigrateCode) { super(code); this.name = 'MigrateError' }
}

/** Under the core's 30 s wait for a service's answer: the target's probe alone may take two 5 s shell reads. */
export const MIGRATE_DEADLINE_MS = 25_000
/** The largest transcript converted. The edge host's heap is 384 MiB, and a conversion holds the file, its parse and
 *  the new file at once; a longer conversation is refused rather than taking every service in the host down with it. */
export const MIGRATE_MAX_BYTES = 32 * 1024 * 1024

export interface MigrateDeps {
  conversations: Pick<ConversationReads, 'resolve' | 'findTranscript' | 'transcriptOk'>
  /** Whether `engine` is installed here and what its own CLI says of its sign-in (true, false, or null: cannot say). */
  probe(engine: MigrateEngine): Promise<{ installed: boolean; signedIn?: boolean | null }>
  /** Where a new agent of `engine` launched now keeps its sessions: Claude Code's `projects`, Codex's home. */
  home(engine: MigrateEngine): Promise<string>
  /** The version `engine --version` names here, or null when it does not answer with one. */
  version(engine: MigrateEngine): Promise<string | null>
  now?: () => number
  newId?: () => string
  deadlineMs?: number
  maxBytes?: number
}

/** The probe the New dialog asks (lib/engineProbe.ts), and the homes a launch made now would use (lib/engineHomes.ts). */
export const productionMigrateDeps = (conversations: MigrateDeps['conversations']): MigrateDeps => ({
  conversations,
  probe: async (engine) => (await probeEngines([engine], { accounts: true }))[0]!,
  home: async (engine) => {
    // The person's shell may move CLAUDE_CONFIG_DIR or CODEX_HOME, and the agent's pane runs in that shell.
    await warmLoginShellEnvironment()
    if (engine === 'codex') return launchCodexHome(null)
    const home = sessionClaudeHome({ transcriptPath: null })
    return home === dirname(env.CLAUDE_PROJECTS_DIR) ? env.CLAUDE_PROJECTS_DIR : join(home, 'projects')
  },
  // In the shell a launch runs in, as the probe finds the engine: `codex-cli 0.130.0`, `2.1.200 (Claude Code)`.
  version: async (engine) => {
    const ran = await commandOutputInInteractiveShell(engine, engine, ['--version'])
    return ran?.code === 0 ? /\b\d+\.\d+\.\d+\b/.exec(ran.output)?.[0] ?? null : null
  },
})

const inFlight = new Map<string, Promise<Record<string, unknown>>>()

/** The request's handler: the owner's alone, checked before anything is read, answered with fixed fields and a code. */
export function createSessionMigrate(deps: MigrateDeps) {
  return (payload: Record<string, unknown>, asker: { owner: boolean }): Promise<Record<string, unknown>> => {
    if (!asker.owner) return Promise.resolve({ error: 'OWNER_REQUIRED' })
    const agentId = payload.agentId
    if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 200) return Promise.resolve({ error: 'MISSING_AGENT_ID' })
    const target = payload.targetEngine
    if (typeof target !== 'string' || !(MIGRATE_ENGINES as readonly string[]).includes(target)) return Promise.resolve({ error: 'BAD_ENGINE' })
    // A retry while the first is still converting shares it, so one request that arrives twice writes one session.
    const running = inFlight.get(agentId)
    if (running) return running
    const work = answer(deps, agentId, target as MigrateEngine).finally(() => inFlight.delete(agentId))
    inFlight.set(agentId, work)
    return work
  }
}

async function answer(deps: MigrateDeps, agentId: string, target: MigrateEngine): Promise<Record<string, unknown>> {
  const started = performance.now()
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new MigrateError('TIMEOUT')) }, deps.deadlineMs ?? MIGRATE_DEADLINE_MS)
  })
  const label = agentId.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '_')
  try {
    const done = await Promise.race([migrate(deps, agentId, target, () => expired), timeout])
    console.log(`[migrate] ${done.from} → ${target} · ${done.bytes} bytes read · ${done.lines} lines written · ${Math.round(performance.now() - started)} ms`)
    return { engine: target, sessionId: done.sessionId, cwd: done.cwd }
  } catch (error) {
    // Only a code goes on the wire, and the log names the code or the error's kind: a message can quote a path or
    // a slice of the transcript a parser choked on.
    if (error instanceof MigrateError) {
      console.log(`[migrate] ${label} refused · ${error.code}`)
      return { error: error.code }
    }
    console.error(`[migrate] ${label} failed: ${errorKind(error)}`)
    return { error: 'CONVERT_FAILED' }
  } finally { clearTimeout(timer) }
}

const isFolder = (path: string): boolean => { try { return statSync(path).isDirectory() } catch { return false } }

async function migrate(deps: MigrateDeps, agentId: string, target: MigrateEngine, expired: () => boolean) {
  const reads = deps.conversations
  const tick = () => { if (expired()) throw new MigrateError('TIMEOUT') }
  const session = await reads.resolve(agentId)
  tick()
  if (!session) throw new MigrateError('UNKNOWN_AGENT')
  const from = session.engine
  if (!(MIGRATE_ENGINES as readonly string[]).includes(from) || from === target) throw new MigrateError('BAD_ENGINE')
  const cwd = session.cwd
  // A row bound to a subagent's file holds the subagent's session, not this agent's own (lib/agentHandoff.ts).
  if (!session.sessionId || session.identityHold || !cwd || !isAbsolute(cwd) || !isFolder(cwd)
    || session.transcriptPath && isSubagentTranscript(session.transcriptPath)) throw new MigrateError('NO_SESSION')
  // The same evidence the handoff reads a transcript on: a path the core vouches is this engine's file.
  const home = session.codexHome ?? null
  const vouched = async (path: string | null | undefined) => !!path && !isSubagentTranscript(path) && await reads.transcriptOk(from, path, home)
  let path = await vouched(session.transcriptPath) ? session.transcriptPath : null
  if (!path) {
    const found = await reads.findTranscript(from, session.sessionId, home ? { codexHome: home } : {})
    tick()
    if (await vouched(found)) path = found
  }
  tick()
  if (!path) throw new MigrateError('NO_SESSION')

  const probed = await deps.probe(target).catch(() => null)
  tick()
  // Signed out is refused; a CLI that cannot say (its status read timed out) is let through, as the New dialog does:
  // the resumed engine asks for its sign-in itself.
  if (!probed?.installed || probed.signedIn === false) throw new MigrateError('TARGET_UNAVAILABLE')
  const targetHome = await deps.home(target)
  tick()
  const cliVersion = await deps.version(target).catch(() => null)
  tick()

  const size = (await stat(path)).size
  if (size > (deps.maxBytes ?? MIGRATE_MAX_BYTES)) throw new MigrateError('CONVERT_FAILED')
  const text = await readFile(path, 'utf8')
  tick()
  const now = (deps.now ?? Date.now)(), sessionId = (deps.newId ?? randomUUID)()
  const converted = convertSession(from as MigrateEngine, text, { sessionId, cwd, now, ...(cliVersion ? { cliVersion } : {}) })
  const destination = target === 'claude' ? claudeSessionPath(targetHome, cwd, sessionId) : codexRolloutPath(targetHome, now, sessionId)
  // Past the deadline the phone has its TIMEOUT: a file written now would be a session nobody resumes.
  tick()
  writeNewSessionFile(destination, converted.text)
  return { from, sessionId, cwd, lines: converted.text.split('\n').length - 1, bytes: size }
}
