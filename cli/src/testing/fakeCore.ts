/**
 * A `CoreApi` for a service's spec: every member a `vi.fn` with an empty answer, any of them replaced
 * through `over`. Services read the core only through `CoreApi`, so this is all a spec needs to start
 * one (docs/design/2026-10-03-harnessd.md, the core boundary).
 */
import { vi } from 'vitest'
import { CONVERSATIONS_OFF, TERMINALS_OFF, type CoreApi } from '../core/api.js'

type Overrides = { [K in keyof CoreApi]?: CoreApi[K] extends object ? Partial<CoreApi[K]> : CoreApi[K] }

export function fakeCore(over: Overrides = {}): CoreApi {
  return {
    dataDir: over.dataDir ?? '/data',
    conversations: { ...CONVERSATIONS_OFF, ...over.conversations },
    terminals: {
      open: vi.fn(TERMINALS_OFF.open),
      describe: vi.fn(TERMINALS_OFF.describe),
      visitStatus: vi.fn(TERMINALS_OFF.visitStatus),
      watch: { frame: vi.fn(async () => {}), close: vi.fn(async () => {}), onOutput: vi.fn(() => () => {}) },
      ...over.terminals,
    },
    machine: { id: vi.fn(() => 'machine-1'), computerId: vi.fn(() => 'computer-1'), name: vi.fn(() => 'This machine'), ...over.machine },
    agents: {
      all: vi.fn(() => []),
      live: vi.fn(() => []),
      displayName: vi.fn(() => ''),
      byAgent: vi.fn(() => undefined),
      resolve: vi.fn(() => undefined),
      advertised: vi.fn(() => []),
      terminalAvailable: vi.fn(() => false),
      sync: vi.fn(),
      runtimeModels: vi.fn(async () => []),
      runtimeProfile: vi.fn(() => null),
      setRuntime: vi.fn(),
      fork: vi.fn(async () => ({ ok: false as const, error: 'UNSUPPORTED' })),
      create: vi.fn(async () => ({ ok: false as const, error: 'UNSUPPORTED' })),
      dsh: vi.fn(() => null),
      activityText: vi.fn(async () => null),
      ...over.agents,
    },
    turns: {
      send: vi.fn(), stop: vi.fn(), recent: vi.fn(async () => []), asks: vi.fn(async () => []),
      deliver: vi.fn(), cancelDelivery: vi.fn(() => false), onDelivery: vi.fn(() => () => {}),
      ...over.turns,
    },
    questions: { answer: vi.fn(), answerReviewed: vi.fn(async () => false), ...over.questions },
    transcripts: { databaseHistory: vi.fn(() => undefined), lastTurn: vi.fn(async () => null), ...over.transcripts },
    external: {
      sessions: { list: vi.fn(() => []), scan: vi.fn(async () => []) },
      open: { known: vi.fn(() => new Map()), fresh: vi.fn(async () => new Map()) },
      ...over.external,
    },
    account: {
      mintGridName: vi.fn(async () => null),
      accessToken: vi.fn(async () => 'token'),
      lane: {
        hello: vi.fn(async () => ({ type: 'e2e_hello', payload: {} })),
        welcome: vi.fn(async () => true),
        rekey: vi.fn(async () => {}),
        seal: vi.fn(async (_machineId: string, frame: Record<string, unknown>) => ({ frame })),
        open: vi.fn(async (_machineId: string, frame: Record<string, unknown>) => ({ frame })),
        drop: vi.fn(),
      },
      privateGridName: vi.fn(async () => null),
      machineName: vi.fn(() => null),
      backend: vi.fn(async () => ({ status: 200, body: {} })),
      observerKey: { publicKey: vi.fn(async () => 'cHVi'), signWelcome: vi.fn(async () => 'c2ln') },
      onNotice: vi.fn(() => () => {}),
      signedIn: vi.fn(() => true),
      environment: vi.fn(() => 'prod'),
      machines: vi.fn(async () => ({ status: 200, body: { success: true, data: { machines: [] } } })),
      ...over.account,
    },
    clients: {
      viewerChanged: vi.fn(), viewerFrame: vi.fn(() => false), gridNamed: vi.fn(), gridModelsChanged: vi.fn(), dshInstallStatus: vi.fn(), windows: vi.fn(), observer: vi.fn(() => true),
      sendLocal: vi.fn(), sendToWindow: vi.fn(() => true), hasWindow: vi.fn(() => true), devicesChanged: vi.fn(), dialWatching: vi.fn(),
      turnCard: vi.fn(), turnSummary: vi.fn(),
      ...over.clients,
    },
    daemon: { command: 'harness', port: 18473, machineId: () => 'machine-1', autonomousEnv: 'prod', ...over.daemon },
    wifi: {
      view: vi.fn(async () => ({ agents: [], store: [], hasWindow: true })),
      submit: vi.fn(async () => {}), cancel: vi.fn(), started: vi.fn(),
      stop: vi.fn(async () => true), answer: vi.fn(async () => true),
      create: vi.fn(async () => ({ ok: false as const, error: 'UNSUPPORTED' })),
      stepFocus: vi.fn(async () => 'no_agents' as const), scroll: vi.fn(() => true), focusApp: vi.fn(() => true), reveal: vi.fn(),
      send: vi.fn(), hello: vi.fn(), joined: vi.fn(), ready: vi.fn(), unpaired: vi.fn(), focus: vi.fn(),
      transcripts: vi.fn(), watching: vi.fn(), streams: vi.fn(),
      ...over.wifi,
    },
  }
}
