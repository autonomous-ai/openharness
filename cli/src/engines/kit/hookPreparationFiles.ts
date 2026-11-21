/** Native installation uses the existing publisher; setup supplies an in-memory candidate view. */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { directoryChanged, inspectHookFile, runHookPreparation, type HookPreparationFiles, type HookPreparationOptions } from './nativeHookFiles.js'

export function hookPreparationFiles(options: HookPreparationOptions = {}): HookPreparationFiles {
  return options.files ?? {
    report: (stream, ...args) => { console[stream](...args) },
    inspect: inspectHookFile,
    run: runHookPreparation,
    directory(path, mode, attempt) {
      attempt.verify()
      const created = mkdirSync(path, { recursive: true, mode })
      if (created) directoryChanged(attempt, dirname(created))
    },
    async write(file, text, mode, attempt) {
      const observed = inspectHookFile(file, mode)
      observed.prepare(text); attempt.verify()
      const created = mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      if (created) directoryChanged(attempt, dirname(created))
      const published = await observed.replace(text, attempt)
      published.verify()
    },
  }
}
