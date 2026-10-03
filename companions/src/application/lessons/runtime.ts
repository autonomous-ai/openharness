/** Explicit publication into an already prepared optional DSH context. No core lifecycle imports. */
import { appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { installLessons, type RuntimeLessons } from '../../memory/lessons/publish.js'

export function publishRuntimeLessons(contextFile: string, lessons?: RuntimeLessons | null): void {
  const lines = installLessons(dirname(contextFile), lessons)
  if (lines.length) appendFileSync(contextFile, `\n${lines.join('\n')}\n`)
}
