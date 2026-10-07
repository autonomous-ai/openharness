/**
 * When models' process starts (harnessd/services.ts `models`, on demand since protocol 4): as the core starts when
 * models has work of its own here, and otherwise at the first request that needs it (core/serviceLinks.ts
 * `onDemand`), which waits for it. A computer that uses no grid never pays its 70 MiB.
 *
 * Its own work, with no request coming in: a managed grid's pin, followed at every start of models and every ten
 * minutes (`current-grid` in the runtime folder), and the saved grid pictures it reads back and tells the core,
 * which reads agents' grid notes and the keystroke prewarm from them (`grid-pictures/`). The Model Manager's local
 * models (`local-models/`) count too: a computer running models of its own uses grid.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface GridInUseDeps { dataDir: string; runtimeDir: string; exists?: (path: string) => boolean; list?: (folder: string) => string[] }

/** Why grid is in use on this computer, as the log says it; null when it is not. */
export function gridInUse(deps: GridInUseDeps): string | null {
  const list = (folder: string): string[] => { try { return (deps.list ?? readdirSync)(folder) } catch { return [] } }
  if ((deps.exists ?? existsSync)(join(deps.runtimeDir, 'current-grid'))) return 'a managed grid'
  if (list(join(deps.dataDir, 'grid-pictures')).some((name) => name.endsWith('.json'))) return 'saved grid pictures'
  return list(join(deps.dataDir, 'local-models')).length ? 'local models' : null
}

/** At the core's start: models' process asked for when it runs out here and grid is in use. */
export function wakeModels(deps: GridInUseDeps & { outOfProcess: ReadonlySet<string>; want(service: string): void; log?(line: string): void }): void {
  const why = deps.outOfProcess.has('models') ? gridInUse(deps) : null
  if (!why) return
  ;(deps.log ?? console.log)(`[models] ${why}: asking for models' process`)
  deps.want('models')
}
