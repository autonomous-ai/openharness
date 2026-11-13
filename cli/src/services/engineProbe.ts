/**
 * Which engines this machine has, asked before a create rather than discovered by one failing: the New dialog, a
 * Swarm's start, a contributed computer's readiness. Answered here, on the machine in question, because a Mac and the
 * Docker rig routinely hold different engines, and a list worked out anywhere else is wrong for exactly the remote
 * case this request exists to serve.
 *
 * A service, in the edge host: a full probe starts up to sixteen interactive login shells, four at once, and reads
 * each engine's sign-in (lib/engineProbe.ts). The core's process started those shells itself, from the socket's
 * request switch, until the audit of 2026-11-12. Nothing here needs the core: the answer is this machine's own.
 */
import { ENGINE_PROBE_REQUESTS, type CoreApi, type ServiceRequests } from '../core/api.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'
import { engineInstallLine, engineInstallRecipe } from '../lib/engineInstall.js'
import { supportsFirstPrompt } from '../lib/engineLaunch.js'
import { probeEngines } from '../lib/engineProbe.js'

export { ENGINE_PROBE_REQUESTS }

export interface EngineProbeDeps {
  /** Swapped in tests for one that starts no shell. */
  probe?: typeof probeEngines
}

/** The line Desktop shows before installing an engine here. */
const installRecipeLine = (engine: AgentEngine): string | undefined => {
  const recipe = engineInstallRecipe(engine)
  return recipe && engineInstallLine(recipe)
}

export function startEngineProbe(_core: CoreApi, deps: EngineProbeDeps = {}): ServiceRequests {
  const probe = deps.probe ?? probeEngines
  return {
    engines_probe: async (payload, asker) => {
      // `engines` narrows the probe to what the caller is showing; an absent or malformed list means "all of them",
      // so an older app that sends nothing still gets a usable answer.
      const asked = Array.isArray(payload.engines)
        ? payload.engines.filter((id): id is AgentEngine => typeof id === 'string' && (ENGINES as readonly string[]).includes(id))
        : []
      try {
        // A guest starts agents on its own sign-in, so it needs only which engines are installed: the owner's
        // sign-in and last use are never read for it (#4259, from #4216's security review).
        const availability = await probe(asked.length > 0 ? asked : undefined, { accounts: asker.guest === undefined })
        return {
          engines: availability.map((entry) => ({
            engine: entry.engine,
            installed: entry.installed,
            command: entry.command,
            installable: entry.installable,
            installCommand: (entry.installable && installRecipeLine(entry.engine)) || null,
            // Installed but unable to run here (OpenClaw on a Node it cannot use): New shows it and blocks Start.
            ...(entry.unavailable ? { unavailable: entry.unavailable } : {}),
            ...(entry.signedIn !== undefined ? { signedIn: entry.signedIn, lastUsedAt: entry.lastUsedAt ?? null } : {}),
            // Static per-CLI-version capability, not a probe result: its mere presence is what lets an older CLI
            // (which never sends the field) keep reading as "unknown" rather than "no", per the desktop app's
            // `EngineAvailability.fromJson`.
            ...(entry.engine === 'codex' ? { supportsCodexHome: true } : {}),
            // Static too, and this machine's own: whether `harness new` here can hand the engine a first prompt
            // (engineLaunch.ts FIRST_PROMPT_ARGS), so a caller on another version reads it from the machine that
            // will start the agent (#1788).
            firstPrompt: supportsFirstPrompt(entry.engine),
            // Static too: a pane whose engine is still downloading beside Desktop Harness's setup waits for that
            // download (engineLaunch.ts `harness_wait_download`) rather than installing it again, so the desktop
            // may open the pane before the download ends.
            waitsForDownload: true,
          })),
        }
      } catch {
        return { error: 'ENGINE_PROBE_FAILED' }
      }
    },
  }
}
