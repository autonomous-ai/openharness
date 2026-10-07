/**
 * `agent_handoff_prepare`, for "Change agent": before the engine is swapped, what the old one did is
 * written into the project (`.harness/handoff/`) so the new one can read it. It writes into the user's
 * folder and runs git there, so only the owner may ask: the loopback window, or a sealed `web` session.
 * A `device` (the dial) and a shared viewer never do.
 *
 * Same owner guards and reply contract after the quiet-machine QA move into the edge host.
 */
import { ENGINES } from '../engines/types.js'

/** What the handoff is asked for, and what it answers (lib/agentHandoff.ts). */
export type HandoffRequest = { agentId: string; changeId: string; targetEngine: string }
export type Handoff = { file: string | null; gitRepo: boolean; cwd: string; degraded: string[] }

/** `prepare` writes the handoff file, or is null while nothing can. */
export function createHandoffRequest({ prepare }: { prepare: ((req: HandoffRequest) => Promise<Handoff>) | null }) {
  /** Answers `agent_handoff_prepare` through `reply`, once the file is written: never in the connection's line. */
  return (payload: Record<string, unknown>, asker: { owner: boolean }, reply: (result: Record<string, unknown>) => void): void => {
    if (!asker.owner) { reply({ error: 'OWNER_REQUIRED' }); return }
    const agentId = payload.agentId
    if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 200) { reply({ error: 'MISSING_AGENT_ID' }); return }
    const changeId = payload.changeId
    if (typeof changeId !== 'string' || !/^[0-9a-f]{32}$/.test(changeId)) { reply({ error: 'BAD_CHANGE_ID' }); return }
    const targetEngine = payload.targetEngine
    if (typeof targetEngine !== 'string' || !(ENGINES as readonly string[]).includes(targetEngine)) { reply({ error: 'BAD_ENGINE' }); return }
    const provider = prepare
    if (!provider) { reply({ error: 'UNSUPPORTED' }); return }
    // DETACHED from this connection's ordered RPC chain, like `engines_probe`: it reads a whole
    // session and runs git, and a window's next request must not queue behind it. The reply names
    // fixed fields only; whatever else the provider returned stays here.
    // Called inside the executor so a provider that throws before returning its promise lands in
    // the same catch (and the same message-free log) as one that rejects.
    void new Promise<Awaited<ReturnType<typeof provider>>>((resolve) => resolve(provider({ agentId, changeId, targetEngine })))
      .then((r) => reply({ agentId, file: r.file, gitRepo: r.gitRepo, cwd: r.cwd, degraded: r.degraded }))
      .catch((e: unknown) => {
        // Only a HandoffError's code goes on the wire, and only code-shaped: the reply never carries
        // a message or anything else the provider put in it.
        const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
        const known = (e as { name?: unknown } | null)?.name === 'HandoffError' && typeof code === 'string' && /^[A-Z][A-Z_]{0,39}$/.test(code)
        // Name and errno code only: a message can quote the project path or, from a parser, a
        // slice of the transcript it choked on.
        if (!known) console.error(`[handoff] prepare failed: ${e instanceof Error ? e.name : typeof e}${typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? ` ${code}` : ''}`)
        reply({ error: known ? code : 'INTERNAL' })
      })
  }
}
