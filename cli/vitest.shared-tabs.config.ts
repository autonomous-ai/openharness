import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/** Shared tabs across accounts (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md):
 *  the new files outside the core and services, which no other gate covers, held to 100% in every file. */
const FILES = [
  'src/lib/e2ee/tabSession.ts',
  'src/messages/roster.ts',
  'src/messages/shape.ts',
  'src/messages/rosterStore.ts',
  'src/messages/consentStore.ts',
  'src/messages/requestStore.ts',
  'src/messages/noticeStore.ts',
  'src/messages/sharedTabs.ts',
  'src/messages/sharedTabsRoster.ts',
  'src/gateway/tabKey.ts',
  'src/lib/tabKeyWire.ts',
  'src/lib/tabRelayWire.ts',
  'src/gateway/tabRelay.ts',
  'src/messages/sharedDirectory.ts',
  'src/messages/tabDelivery.ts',
  'src/messages/tasks.ts',
  'src/messages/tabActivity.ts',
]
export default defineConfig({
  test: {
    ...base.test,
    include: FILES.map(f => f.replace(/\.ts$/, '.spec.ts')).concat('src/messages/sharedTabs.integration.spec.ts'),
    coverage: {
      enabled: true, provider: 'v8', include: FILES,
      reporter: ['text', 'json-summary'], reportsDirectory: 'coverage/shared-tabs',
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
