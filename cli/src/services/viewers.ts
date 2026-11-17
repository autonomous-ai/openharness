import type { ClientStreamEndpoint } from '../lib/clientStreamContract.js'
/**
 * A DSH agent has two things beside its pane that the daemon owns for as long as the agent exists:
 * its viewer server (a URL the desktop shows in a pane next to the terminal) and a watch on the
 * verdict file its scripts write. Both are keyed on the agent: attached at every look the core takes at an
 * agent with a `dsh` (create, restore, discovery), and detached when it ends, both heard as every service
 * that follows agents hears them (`CoreApi.agents.follow`, `VIEWERS_FOLLOW`).
 *
 * It also serves those viewers to a client that cannot reach this machine's loopback (the phone, the web,
 * a window on another of the owner's machines): a viewer's pages streamed over the client's own connection
 * (lib/viewerForwarder.ts), and frames of it rendered by a headless browser (lib/interactiveViewer.ts).
 * They ran in the core's process until 6 October; here they run where the viewer servers they forward to
 * do, and whatever they cost (a stalled stream, a browser per surface) is the viewers' alone.
 *
 * A service on the core boundary (docs/design/2026-10-03-harnessd.md, step 13): it reads the core
 * only through `CoreApi`, and the core reaches it only through `ports.viewers`.
 */
import { join } from 'node:path'
import { VIEWERS_FOLLOW, type AgentView, type CoreApi, type ViewersPort } from '../core/api.js'
import { env } from '../config/env.js'
import { catalogEntry } from '../dsh/catalog.js'
import { installedDsh } from '../dsh/installed.js'
import { dshVerdictPath, dshViewerName } from '../dsh/manifest.js'
import { DshVerdictWatcher, type DshVerdict } from '../dsh/verdict.js'
import { DshViewerManager } from '../dsh/viewer.js'
import { ViewerLedger } from '../dsh/viewerLedger.js'
import type { AgentDshContext } from '../lib/agentFrame.js'
import { InteractiveViewers } from '../lib/interactiveViewer.js'
import { sid } from '../lib/log.js'
import type { RegisteredSession } from '../lib/registry.js'
import { ViewerForwarder } from '../lib/viewerForwarder.js'

/** This machine's viewers, served to clients over their connections: what `ViewersPort` names `stream`,
 *  `surface` and `closed`, and what follows a viewer that moved or stopped (`refresh`). */
export function serveViewers(
  /** Where an agent's viewer is served now, or null. */
  target: (agentId: string) => string | null,
  /** A stream's frame to the one connection that opened it (`CoreApi.clients.streamFrame`). */
  send: (connId: string, type: string, payload: Record<string, unknown>) => boolean,
) {
  const forwarder = new ViewerForwarder({ target, send })
  const surfaces = new InteractiveViewers(target)
  return {
    stream: (connId: string, type: string, payload: Record<string, unknown>): boolean => {
      forwarder.handle(connId, type, payload)
      return true
    },
    surface: (connId: string, payload: Record<string, unknown>) => surfaces.request(connId, payload),
    closed: (connId?: string): void => {
      if (connId === undefined) { forwarder.closeAll(); surfaces.closeAll(); return }
      forwarder.closeConnection(connId)
      surfaces.closeConnection(connId)
    },
    /** Before another process can take the old viewer's port, nothing may still be forwarded to it. */
    refresh: (agentId: string): void => {
      forwarder.refresh(agentId)
      surfaces.refresh(agentId)
    },
  }
}

export interface ViewersRuntime extends ViewersPort {
  stream(connection: string, type: string, payload: Record<string, unknown>): boolean
  closed(connection?: string): void
}
export interface ViewersRuntimeSlot { viewers: ViewersRuntime | null }

export function startViewers(core: CoreApi, ports: ViewersRuntimeSlot): void {
  const sessions = new Map<string, AgentView>()
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
  const publish = (session: AgentView): void => {
    const context = dshFrameContext(session)
    core.agents.publishFrame?.(session, context ? { dsh: context.id, dshName: context.name ?? null,
      viewerUrl: context.viewerUrl ?? null, viewerName: context.viewerName ?? null, verdict: context.verdict ?? null } : {})
  }
  // A companion's news is published immediately; the core sends its frame only once
  // the agent's terminal is attached. During a daemon start the viewer is often up before the
  // pane is re-attached, and a frame with no terminal reads to the desktop as "agent gone": it
  // closed the tiles of every harness agent on every restart (seen 2026-09-15, three times). The
  // attach's own sync carries whatever arrived first.
  const syncCompanion = (agentId: string): void => {
    const session = sessions.get(agentId)
    if (session) publish(session)
  }
  // Viewers an earlier daemon started and never stopped (crash, force quit, SIGKILL) are still running
  // and still polling; stop them BEFORE this daemon starts its own, or they accumulate a generation per
  // restart. Only pids whose live start time matches what that daemon recorded are touched.
  const viewerLedger = new ViewerLedger({ log: (line) => console.log(line) })
  viewerLedger.reapOrphans()
  const served = serveViewers((agentId) => dshViewers.forwardingUrl(agentId), (connId, type, payload) => core.clients.streamFrame(connId, type, payload))
  const dshViewers = new DshViewerManager({
    onUrl: (agentId, url) => {
      dshFrameFor(agentId).viewerUrl = url
      served.refresh(agentId)
      core.clients.viewerChanged(agentId)
      syncCompanion(agentId)
    },
    log: (line) => console.log(line),
    ledger: viewerLedger,
    // A verdict's preview is the agent's own page; this daemon's API is never one.
    reservedPorts: () => [env.PORT],
  })
  const dshVerdicts = new DshVerdictWatcher({
    onChange: (agentId, verdict) => {
      dshFrameFor(agentId).verdict = verdict
      // The verdict's artifact is what the viewer should show, when it names one.
      dshViewers.setVerdictArtifact(agentId, verdict?.artifact ?? null)
      // A page the agent serves itself (its dev server) is shown in place of the package's, once it listens.
      dshViewers.setVerdictPreview(agentId, verdict?.preview ?? null)
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
    void dshViewers.stop(agentId).catch(() => console.warn('[viewers] VIEWER_STOP_FAILED'))
    dshFrames.delete(agentId)
  }
  const unfollow = core.agents.follow?.((event) => {
    if (event.kind === 'running') {
      const session = event.session
      const prior = sessions.get(session.agentId)
      if (prior && session.frameEpoch && prior.frameEpoch !== session.frameEpoch) {
        sessions.delete(session.agentId)
        detachDsh(session.agentId)
      }
      sessions.set(session.agentId, session)
      attachDsh(session)
      publish(session)
    } else if (event.kind === 'ended') {
      sessions.delete(event.agentId)
      detachDsh(event.agentId)
    }
  }, VIEWERS_FOLLOW)
  ports.viewers = {
    forwardingUrl: (agentId) => dshViewers.forwardingUrl(agentId),
    // The next daemon starts its own viewers for the agents it restores; these must not hold the ports.
    stop: async () => {
      unfollow?.()
      sessions.clear()
      served.closed()
      await dshViewers.stopAll()
      await dshVerdicts.stop()
    },
    stream: served.stream,
    surface: served.surface,
    closed: served.closed,
  }
}

export function viewerStreamEndpoint(port: ViewersRuntime): ClientStreamEndpoint {
  return {
    frame: event => port.stream(event.connection, event.type, event.payload),
    binary: () => false,
    closed: connection => port.closed(connection),
    control: () => {},
    refused: (grant, _streamId, connection) => {
      if (connection !== undefined) port.stream(connection, 'viewer_close', { streamId: grant, error: 'Viewer connection closed' })
    },
  }
}
