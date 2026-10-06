/**
 * A `CoreApi` for a service's spec: every member a `vi.fn` with an empty answer, any of them replaced
 * through `over`. Services read the core only through `CoreApi`, so this is all a spec needs to start
 * one (docs/design/2026-10-03-harnessd.md, the core boundary).
 */
import { vi } from 'vitest'
import type { CoreApi } from '../core/api.js'

type Overrides = { [K in keyof CoreApi]?: CoreApi[K] extends object ? Partial<CoreApi[K]> : CoreApi[K] }

export function fakeCore(over: Overrides = {}): CoreApi {
  return {
    dataDir: over.dataDir ?? '/data',
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
      ...over.agents,
    },
    turns: { send: vi.fn(), stop: vi.fn(), recent: vi.fn(() => []), asks: vi.fn(() => []), ...over.turns },
    questions: { answer: vi.fn(), answerReviewed: vi.fn(async () => false), ...over.questions },
    transcripts: { databaseHistory: vi.fn(() => undefined), ...over.transcripts },
    external: {
      sessions: { list: vi.fn(() => []), scan: vi.fn(async () => []) },
      open: { known: vi.fn(() => new Map()), fresh: vi.fn(async () => new Map()) },
      ...over.external,
    },
    account: {
      mintGridName: vi.fn(async () => null),
      accessToken: vi.fn(async () => 'token'),
      privateGridName: vi.fn(async () => null),
      machineName: vi.fn(() => null),
      ...over.account,
    },
    clients: { viewerChanged: vi.fn(), gridNamed: vi.fn(), gridModelsChanged: vi.fn(), dshInstallStatus: vi.fn(), ...over.clients },
  }
}
