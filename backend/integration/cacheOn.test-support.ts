// Every super-tabs integration suite runs with the read cache on (superTabs/cache.ts): one process's cache over stamps in
// memory, as Redis would hold them. A test that writes parts outside the store uses swarmTransaction, as every writer does.
import { configureSwarmStamps } from '../src/superTabs/cache.js'
import { MemoryStamps } from '../src/superTabs/cache.test-support.js'

configureSwarmStamps(new MemoryStamps())
