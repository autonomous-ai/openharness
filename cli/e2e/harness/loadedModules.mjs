// What each daemon process loads (e2e/swarmSwitch.e2e.ts): every module a process resolves to load, one file:// URL a
// line, in <E2E_LOADED_MODULES_DIR>/<pid>.txt. Given through NODE_OPTIONS, it rides into every process the master
// starts: the core, each service's process and the engines' readers.
import { register } from 'node:module'
import { join } from 'node:path'

const dir = process.env.E2E_LOADED_MODULES_DIR
if (dir) register('./loadedModulesHooks.mjs', import.meta.url, { data: { file: join(dir, `${process.pid}.txt`) } })
