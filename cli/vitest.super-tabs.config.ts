// cli/vitest.super-tabs.config.ts
import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/** New files outside the core and services, which no other gate covers, held to 100% in every file. And the Swarm's side of
 *  the core's process (superTabs/inCore/), which left the core's own 100% gate when the Swarm became a switch. */
const IN_CORE = ['adoption', 'agents', 'attention', 'cards', 'deliveries', 'launch', 'role', 'teamApps', 'teamPurge', 'terminal'].map(name => `src/superTabs/inCore/${name}.ts`)
const FILES = ['src/superTabs/shortCommand.ts', ...IN_CORE,
  // The replies the host owes a person who talked to their agent in its own chat, posted when the agent's turn ends (anh Dee, 11-09).
  'src/superTabs/agentReplies.ts',
]
export default defineConfig({
  test: {
    ...base.test,
    include: FILES.map(f => f.replace(/\.ts$/, '.spec.ts')),
    coverage: { enabled: true, provider: 'v8', include: FILES, thresholds: { perFile: true, lines: 100, statements: 100, branches: 100, functions: 100 } },
  },
})
