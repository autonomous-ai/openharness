/**
 * A DSH agent has two things beside its pane that the daemon owns for as long as the agent exists:
 * its viewer server (a URL the desktop shows in a pane next to the terminal) and a watch on the
 * verdict file its scripts write. Both are keyed on the agent, attached wherever an agent with a
 * `dsh` comes into being (create, restore, discovery) and detached where it is forgotten.
 *
 * A service on the core boundary (docs/design/2026-10-03-harnessd.md, step 13): it reads the core
 * only through `CoreApi`, and the core reaches it only through `ports.viewers`.
 */
import { join } from 'node:path'
import type { CoreApi, CorePorts } from '../core/api.js'
import { catalogEntry } from '../dsh/catalog.js'
import { installedDsh } from '../dsh/installed.js'
import { dshVerdictPath, dshViewerName } from '../dsh/manifest.js'
import { DshVerdictWatcher, type DshVerdict } from '../dsh/verdict.js'
import { DshViewerManager } from '../dsh/viewer.js'
import { ViewerLedger } from '../dsh/viewerLedger.js'
import type { AgentDshContext } from '../lib/agentFrame.js'
import { sid } from '../lib/log.js'
import type { RegisteredSession } from '../lib/registry.js'

export function startViewers(core: CoreApi, ports: CorePorts): void {
  const dshFrames = new Map<string, { viewerUrl: string | null; verdict: DshVerdict | null }>()
  const dshFrameFor = (agentId: string): { viewerUrl: string | null; verdict: DshVerdict | null } => {
    let state = dshFrames.get(agentId)
    if (!state) { state = { viewerUrl: null, verdict: null }; dshFrames.set(agentId, state) }
    return state
  }
  const dshFrameContext = (s: RegisteredSession): AgentDshContext | null => {
    if (!s.dsh) return null
    const state = dshFrames.get(s.agentId)
    const installed = installedDsh(s.dsh)
    return {
      // The current id, so a face drawn by id survives a rename the agent predates.
      id: installed?.id ?? s.dsh,
      name: installed?.manifest.name ?? catalogEntry(s.dsh)?.name ?? null,
      viewerUrl: state?.viewerUrl ?? null,
      // The pane beside the terminal says what it is, so the harness's name is not printed twice.
      viewerName: installed ? dshViewerName(installed.manifest, (id) => installedDsh(id)?.manifest.name ?? catalogEntry(id)?.name) : null,
      verdict: state?.verdict ?? null,
    }
  }
  // A companion's news (a viewer URL, a verdict) is pushed on the agent's frame — but only once
  // the agent's terminal is attached. During a daemon start the viewer is often up before the
  // pane is re-attached, and a frame with no terminal reads to the desktop as "agent gone": it
  // closed the tiles of every harness agent on every restart (seen 2026-09-15, three times). The
  // attach's own sync carries whatever arrived first.
  const syncCompanion = (agentId: string): void => {
    const session = core.agents.byAgent(agentId)
    if (session && core.agents.terminalAvailable(agentId)) core.agents.sync(session)
  }
  // Viewers an earlier daemon started and never stopped (crash, force quit, SIGKILL) are still running
  // and still polling; stop them BEFORE this daemon starts its own, or they accumulate a generation per
  // restart. Only pids whose live start time matches what that daemon recorded are touched.
  const viewerLedger = new ViewerLedger({ log: (line) => console.log(line) })
  viewerLedger.reapOrphans()
  const dshViewers = new DshViewerManager({
    onUrl: (agentId, url) => {
      dshFrameFor(agentId).viewerUrl = url
      core.clients.viewerChanged(agentId)
      syncCompanion(agentId)
    },
    log: (line) => console.log(line),
    ledger: viewerLedger,
  })
  const dshVerdicts = new DshVerdictWatcher({
    onChange: (agentId, verdict) => {
      dshFrameFor(agentId).verdict = verdict
      // The verdict's artifact is what the viewer should show, when it names one.
      dshViewers.setVerdictArtifact(agentId, verdict?.artifact ?? null)
      syncCompanion(agentId)
    },
    log: (line) => console.log(line),
  })
  const dshWarned = new Set<string>()
  /** Idempotent: safe to call on every observation of the agent. */
  const attachDsh = (s: RegisteredSession): void => {
    if (!s.dsh || !s.cwd) return
    const installed = installedDsh(s.dsh)
    if (!installed) {
      if (!dshWarned.has(s.dsh)) {
        dshWarned.add(s.dsh)
        console.warn(`[dsh] ${s.dsh} is not installed on this machine · agent ${sid(s.agentId)} runs as plain ${s.engine} (no viewer, no verdict)`)
      }
      return
    }
    dshVerdicts.watch(s.agentId, join(s.cwd, dshVerdictPath(installed.manifest)))
    if (installed.manifest.viewer) {
      void dshViewers.start(s.agentId, installed, s.cwd).catch((error) => {
        console.warn(`[dsh] ${s.dsh} viewer failed to start · ${error instanceof Error ? error.message : error}`)
      })
    }
  }
  const detachDsh = (agentId: string): void => {
    dshVerdicts.unwatch(agentId)
    void dshViewers.stop(agentId)
    dshFrames.delete(agentId)
  }
  ports.viewers = {
    attach: attachDsh,
    detach: detachDsh,
    frameContext: dshFrameContext,
    forwardingUrl: (agentId) => dshViewers.forwardingUrl(agentId),
    // The next daemon starts its own viewers for the agents it restores; these must not hold the ports.
    stop: async () => {
      await dshViewers.stopAll()
      await dshVerdicts.stop()
    },
  }
}
