import { join } from 'node:path'
import { TmuxBackend } from '../lib/tmuxBackend.js'
import { ensureTmuxOnPath, tmuxInstallDirectories } from '../lib/tmuxOnPath.js'

// Found by QA on a quiet machine: only this disposable daemon probe may change its PATH.
// If the parent test times out, the next fixture still has the unit worker's original environment.
const before = await new TmuxBackend().create({ label: 'harness-first' })
const adopted = await ensureTmuxOnPath(process.env, '/nonexistent/shell',
  join(process.env.HOME!, '.harness/runtime'), tmuxInstallDirectories(process.env, 'darwin'))
const after = await new TmuxBackend().create({ label: 'harness-first' })
if (!process.send) throw new Error('the installer daemon probe needs its parent IPC channel')
process.send({ before, adopted, after }, () => { if (process.connected) process.disconnect() })
