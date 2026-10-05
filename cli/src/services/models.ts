/**
 * Models: grid, how Harness runs local AI models with Codex, Claude Code and the other engines
 * (docs/design/2026-10-03-harnessd.md, "Models"). Grid access on first use, the model pictures an
 * agent's frame carries, and starting a sleeping grid while someone types to its agent.
 *
 * A service on the core boundary (step 13): it reads the core only through `CoreApi`, and the core
 * reaches it only through `ports.models`.
 */
import type { CoreApi, CorePorts } from '../core/api.js'
import { createGridAccess, gridNamesLocal, reconcileGridAttach } from '../lib/gridAttach.js'
import { resetGridDeriveMemo, signedInGridEmail } from '../lib/gridDerive.js'
import { ensureHarnessGrid } from '../lib/gridEnsure.js'
import { gridAvailable } from '../lib/gridExec.js'
import { handOffToGrid } from '../lib/gridHandoff.js'
import { ensureGridInstalled } from '../lib/gridInstall.js'
import { clearGridMcpUrlCache } from '../lib/gridMcpUrl.js'
import { forgetGridModels, gridAnnotation, keystrokePrewarm, onGridModelsChanged, warmGridModels } from '../lib/gridModels.js'
import { ensureManagedGrid } from '../lib/runtimeInstall.js'

export function startModels(core: CoreApi, ports: CorePorts): void {
  // Grid is an add-on (`lib/gridAttach.ts`): nothing on this path installs `grid`, signs this machine in
  // to it or creates a grid. The first grid feature a person uses — the models picker's Set up, a local
  // model's Get or Use, an agent moved onto a grid model, the Model Manager — asks `ports.models.ensure`,
  // which does it then, with this machine's harness token (no second browser) and, only for what needs
  // one, the account's own grid. It used to run here on every start and every reconnect.
  const gridLog = (line: string): void => console.log(`[grid-attach] ${line}`)
  const gridAccess = createGridAccess({
    signedIn: () => signedInGridEmail() !== null,
    log: gridLog,
    attempt: ({ ownGrid, signedInThisRun }) => reconcileGridAttach({
      // The pinned managed runtime first; grid's own installer when there is none to follow.
      installCli: async () => {
        await ensureManagedGrid((m) => console.log(`[grid-runtime] ${m}`))
        if (gridAvailable()) return
        const installed = await ensureGridInstalled()
        if (installed.status !== 'present') gridLog(installed.message)
      },
      gridAvailable: () => gridAvailable(),
      // The backend mints and remembers the name, through the core, which holds the sign-in.
      mintName: () => core.account.mintGridName(),
      accessToken: () => core.account.accessToken(),
      signedInEmail: () => signedInGridEmail(),
      gridNames: () => gridNamesLocal(),
      handoff: (token) => handOffToGrid(token, { json: true }),
      ensure: (name) => ensureHarnessGrid(name),
      onName: (name) => {
        // Answer the picker with this account's grid at once, and drop the memos a stale or absent
        // sign-in may have filled — the model list, the derived name, and the web-tools URL.
        core.clients.gridNamed(name)
        forgetGridModels()
        resetGridDeriveMemo()
        clearGridMcpUrlCache()
      },
      log: gridLog,
    }, { ownGrid, signedInThisRun }),
  })

  // An agent's frame says what its grid's picture says (`grid.state`, and a `grid.note` when its model
  // will not answer). The picture changes on reads nobody waited for, so the frames of the agents whose
  // annotation moved are pushed again — only those, and only when it moved.
  const announcedGrid = new Map<string, string>()
  onGridModelsChanged(() => {
    const onGrid = core.agents.advertised().filter((s) => s.grid)
    const present = new Set(onGrid.map((s) => s.agentId))
    for (const agentId of [...announcedGrid.keys()]) if (!present.has(agentId)) announcedGrid.delete(agentId)
    for (const s of onGrid) {
      const said = JSON.stringify(gridAnnotation(s.grid))
      if (announcedGrid.get(s.agentId) === said) continue
      announcedGrid.set(s.agentId, said)
      core.agents.sync(s)
    }
  })
  // The pictures saved before this start, back in memory with nothing read from any grid: an agent's
  // frame carries its grid's state and note, and a keystroke can start its grid, before any window asks
  // for the list (after a self-update, a phone may be the only one typing).
  void warmGridModels().catch(() => {})
  ports.models = {
    ensure: (request) => gridAccess.ensure(request),
    // Offline, for every list read: is there a `grid` here holding a sign-in? What decides whether the
    // picker offers local and shared models or a Set up row.
    setUp: () => gridAvailable() && signedInGridEmail() !== null,
    // The keystroke prewarm (grid-reads-without-waking issue 03): typing into a pane whose agent runs on
    // a sleeping grid starts that grid while the person types.
    prewarm: (grid) => { void keystrokePrewarm(grid).catch(() => {}) },
    // The web-tools cache lives exactly as long as the sign-in.
    signedOut: () => clearGridMcpUrlCache(),
  }
}
