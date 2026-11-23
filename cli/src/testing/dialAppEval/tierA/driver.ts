/**
 * Tier A's driver (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier A: replay, in process"): each scenario on a
 * fresh world of its own (world.ts), the devices started for the platform it is run on, on virtual time.
 *
 * The platform reaches every part that reads it through the devices' deps: the `orca` deps (Orca's own CLI, the taps'
 * and the links' commands, and the editors' adapters', cable/hosts/vscode.ts, cursorFolder.ts, open.ts, appLink.ts), the
 * Codex queue's, the raises and the store places. The `process.platform` reads left on the devices' paths decide nothing
 * a check reads, on a Mac or a Linux host alike: each is in a default the world replaces (cable/hosts/codexQueue.ts,
 * cmuxCli.ts, orca.ts orcaDeps, kitty.ts, scannedApp.ts, vscodeTerminals.ts readForeground, devices/vscodeExtension.ts
 * vscodeExtensionDeps, devices/orcaHomes.ts orcaHomesDeps, devices/orcaPlugin.ts; cable/serial.ts, boardReset.ts,
 * usbConsoleUser.ts), the address of a client it stands in for (herdrClient.ts, hcClient.ts, opencodeClient.ts), or the
 * dial setup's ownership of its files (devices/dialSkill.ts); the Orca plugin's own `inputs.platform` is on no tier A
 * path, as tier A plays the plugin's messages itself (docs/plans/2026-11-22-dial-eval-orca-plan.md, Decision 20). A step
 * that meets a read that does decide one says so with `world.gap`, which leaves that scenario on that platform out of the
 * scores.
 */
import { vi } from 'vitest'
import type { startDevices } from '../../../services/devices.js'
import { CAROUSEL_REFRESH_MS } from '../../dialCarousel.js'
import { EDITORS, PAGE, type App, type Editor, type EvalDriver, type Platform, type Scenario, type Seen, type Step,
  type StepKind } from '../types.js'
import { installClock, settle } from './clock.js'
import { installFakeApps } from './fakeApps.js'
import { machine } from './machine.js'
import { claudeStoreSteps } from './steps/claudeStore.js'
import { codexStoreSteps } from './steps/codexStore.js'
import { dialSteps } from './steps/dial.js'
import { closeWindows, editorSteps, reopenWindows } from './steps/editor.js'
import { closeOrca, orcaModelSteps, reopenOrca } from './steps/orca.js'
import { sessionsSteps } from './steps/sessions.js'
import { voiceSteps } from './steps/voice.js'
import { windowSteps } from './steps/window.js'
import { World, type StepHandler, type TierAWorld } from './world.js'

type Run = Exclude<Step, { kind: 'wait' }>
const isEditor = (app: App): app is Editor => (EDITORS as readonly App[]).includes(app)
/** iTerm2's steps, each built by its own task of docs/plans/2026-11-22-dial-eval-iterm2-plan.md (Tasks 4-7): until
 *  then a scenario that runs one fails. */
const notBuilt = (kind: StepKind) => (): Promise<void> => Promise.reject(new Error(`tier A: the ${kind} step is not built yet`))
const STEPS: { [K in Exclude<StepKind, 'wait'>]: StepHandler<K> } = {
  ...claudeStoreSteps, ...codexStoreSteps, ...sessionsSteps, ...windowSteps, ...dialSteps, ...voiceSteps, ...editorSteps,
  ...orcaModelSteps,
  'iterm.tab': notBuilt('iterm.tab'), 'iterm.split': notBuilt('iterm.split'), 'iterm.closeTab': notBuilt('iterm.closeTab'),
  'iterm.select': notBuilt('iterm.select'), 'iterm.relaunch': notBuilt('iterm.relaunch'), 'tmux.detach': notBuilt('tmux.detach'),
  'tmux.attach': notBuilt('tmux.attach'), 'tmux.selectPane': notBuilt('tmux.selectPane'), 'herdr.focus': notBuilt('herdr.focus'),
  'herdr.restart': notBuilt('herdr.restart'), 'devices.restart': notBuilt('devices.restart'),
  // An editor's windows go with it, and come back on its relaunch reporting its sessions' new shells. Orca's watches and
  // the plugin's stream go with Orca, and the stream comes back on its relaunch.
  quit: async (world, step) => {
    await sessionsSteps.quit(world, step)
    if (isEditor(step.app)) closeWindows(world, step.app)
    if (step.app === 'orca') closeOrca(world)
  },
  relaunch: async (world, step) => {
    await sessionsSteps.relaunch(world, step)
    if (isEditor(step.app)) await reopenWindows(world, step.app)
    if (step.app === 'orca') reopenOrca(world)
  },
}
/** Virtual time for the dial to be found and welcomed: the fleet looks every 2 s, the dial greets every 2 s. */
const START_WITHIN_MS = 30_000

export class TierADriver implements EvalDriver {
  readonly tier = 'a' as const
  private world: World | undefined
  private steps: Seen['steps'] = []
  /** The index in the scenario of the next step after the last one run. */
  private next = 0

  constructor(private readonly deps: { startDevices: typeof startDevices }) {}

  async start(scenario: Scenario, platform: Platform): Promise<void> {
    installClock()
    machine.reset()
    this.steps = []
    this.next = 0
    const world = this.world = new World(scenario, platform, this.deps.startDevices)
    // Before the dial is up: a link the devices run from then on reaches the apps. The world sees words typed and answers
    // Orca's CLI from its start (world.ts).
    installFakeApps(world)
    await world.quiet()
    const front = scenario.world?.front ?? scenario.app
    await windowSteps.front(world, { kind: 'front', app: front })
    world.dial.replug()
    await this.settle(START_WITHIN_MS, () => world.dial.welcomed)
    if (!world.dial.welcomed) throw new Error(`${scenario.id} on ${platform}: the devices never welcomed the dial`)
    // The person picks the app's page. While no session of it is listed the devices keep the ring they show, and the app
    // in front decides it once one is.
    world.dial.pick(PAGE[front === 'other' ? scenario.app : front])
    await world.quiet()
    world.origin = Date.now()
  }

  async step(step: Run): Promise<void> {
    const world = this.need()
    const index = world.scenario.steps.indexOf(step, this.next)
    if (index < 0) throw new Error(`${world.scenario.id}: a ${step.kind} step that is not its next`)
    this.next = index + 1
    // The person speaks to the session the glass shows, and the glass applies a list the dial just heard within its
    // refresh period: speaking at the moment the list came, they would speak to a face that has not drawn it yet.
    if (step.kind === 'voice') {
      const target = world.agentId(step.target)
      await this.settle(CAROUSEL_REFRESH_MS, () => world.dial.faces.at(-1)?.active === target)
      // A face that never showed the target is not the scenario's: its scores are left out, saying why. The person
      // speaks all the same, so words that reach another session still fail the gate.
      if (world.dial.faces.at(-1)?.active !== target) world.gap(`voice step ${index}: the face never showed ${step.target}`)
    }
    this.steps.push({ at: Date.now(), index, kind: step.kind, ...(step.label === undefined ? {} : { label: step.label }) })
    await (STEPS[step.kind] as (world: TierAWorld, step: Run) => Promise<void>)(world, step)
    // What the step set going lands before anything else happens: the next step comes at the same virtual moment.
    await world.quiet()
  }

  settle(ms: number, until?: () => boolean): Promise<void> {
    return settle(ms, until, this.need().inFlight)
  }

  seen(): Seen {
    return this.need().seen(this.steps)
  }

  gaps(): string[] {
    return [...this.need().gaps]
  }

  async stop(): Promise<void> {
    const world = this.world
    try {
      await world?.close()
    } finally {
      vi.useRealTimers()
      vi.unstubAllEnvs()
      world?.remove()
    }
  }

  private need(): World {
    if (!this.world) throw new Error('tier A: no scenario started')
    return this.world
  }
}
