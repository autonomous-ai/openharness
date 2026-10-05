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
      advertised: vi.fn(() => []),
      terminalAvailable: vi.fn(() => false),
      sync: vi.fn(),
      ...over.agents,
    },
    transcripts: { databaseHistory: vi.fn(() => undefined), ...over.transcripts },
    external: {
      sessions: { list: vi.fn(() => []), scan: vi.fn(async () => []) },
      open: { known: vi.fn(() => new Map()), fresh: vi.fn(async () => new Map()) },
      ...over.external,
    },
    account: { mintGridName: vi.fn(async () => null), accessToken: vi.fn(async () => 'token'), ...over.account },
    clients: { viewerChanged: vi.fn(), gridNamed: vi.fn(), dshInstallStatus: vi.fn(), ...over.clients },
  }
}
