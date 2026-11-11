// cli/vitest.super-tabs.config.ts
import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/** New files outside the core and services, which no other gate covers, held to 100% in every file. And the Swarm's side of
 *  the core's process (superTabs/inCore/), which left the core's own 100% gate when the Swarm became a switch. */
const IN_CORE = ['adoption', 'agents', 'attention', 'cards', 'deliveries', 'launch', 'role', 'terminal'].map(name => `src/superTabs/inCore/${name}.ts`)
const FILES = ['src/superTabs/shortCommand.ts', ...IN_CORE,
  // The replies the host owes a person who talked to their agent in its own chat, posted when the agent's turn ends (anh Dee, 11-09).
  'src/superTabs/agentReplies.ts',
  // An agent's answer to its launch line, in its chat with its person (anh Dee, 11-10).
  'src/superTabs/firstAnswers.ts',
  // An agent's next thing, typed as its turn ends (Swarm plan, step 1, item 1, 11-11).
  'src/superTabs/nextThing.ts',
  // A project's numbers, told to its PM when work runs short and posted once a day (anh Dee, 11-11).
  'src/superTabs/pmNumbers.ts',
  // Each builder's steps under the day's counts (Swarm plan, step 8, 11-11).
  'src/superTabs/daySteps.ts',
  // A piece cut off a task by its builder (anh Dee, 11-11).
  'src/superTabs/githubSplit.ts',
  // A project's goal, scored from main's checks, and the file and workflow it starts from (anh Dee, 11-11).
  'src/superTabs/goal.ts', 'src/superTabs/goalStarter.ts',
  // The leaderboard's daemon half: what its person's agents shipped, read with their own gh and reported as counts.
  'src/superTabs/shipping.ts', 'src/superTabs/shippingRead.ts',
]
export default defineConfig({
  test: {
    ...base.test,
    include: FILES.map(f => f.replace(/\.ts$/, '.spec.ts')),
    coverage: { enabled: true, provider: 'v8', include: FILES, thresholds: { perFile: true, lines: 100, statements: 100, branches: 100, functions: 100 } },
  },
})
