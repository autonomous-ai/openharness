/**
 * Why a `New agent` whose engine started and exited before discovery saw it became a terminal, said once in the
 * daemon log (core/agents/newPane.ts) before the pane becomes an ordinary terminal and nothing else records that an
 * engine was meant to be there; and the argv redaction a removal line goes through (lib/signOut.ts).
 */

import type { AgentEngine } from '../engines/types.js'

/**
 * Blank anything in an argv that looks like a credential: a sign-in removal's line can quote the command line of
 * the process that signed the person out, and a log is the wrong place to find one.
 */
export function redactArgv(args: string): string {
  return args
    .replace(/(--?[\w-]*(?:key|token|secret|password|passwd|auth|credential)[\w-]*[= ])\S+/gi, '$1<redacted>')
    // A long opaque run of credential-shaped characters is not something a launch argv needs to show.
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted>')
}

/** `"codex" started and exited with status 3 after 1.4s`: the engine by its name and how it ended, never its words. */
export function describeAgentCreateFailure(engine: AgentEngine, exitStatus: number, elapsedMs: number): string {
  return `"${engine}" started and exited with status ${exitStatus} after ${(elapsedMs / 1000).toFixed(1)}s`
}
