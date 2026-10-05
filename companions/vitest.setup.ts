import '../cli/vitest.setup.js'
import { join } from 'node:path'

// Optional feature tests own their fixture paths; the core never configures this store.
process.env.HARNESS_LESSONS_DIR = join(process.env.ADAPTER_DATA_DIR!, 'lessons')
