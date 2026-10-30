/** The files a session changed, for Change agent's handoff record: read from the tool-call lines the turn index
 *  already keeps (`toolText`, lib/sessionSearch/turns.ts). The normalizers map every engine onto one vocabulary,
 *  so one list serves all: Codex's apply_patch arrives as `ApplyPatch` with the patch's file names. */
import { isAbsolute, relative } from 'node:path'
import type { IndexedTurn } from './sessionSearch/turns.js'

/** Tools whose single value is the one file they write; the rest of the line is that path, spaces included. */
const ONE_FILE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Tools whose values are the files a patch touches, one per word. */
const PATCH = new Set(['ApplyPatch'])
const PATH_MAX = 200

function shown(cwd: string, path: string): string {
  const clean = path.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  const inside = isAbsolute(clean) ? relative(cwd, clean) : clean
  const name = inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : clean
  return name.slice(0, PATH_MAX)
}

/** Newest first, each once, at most `max`. */
export function changedFiles(turns: readonly IndexedTurn[], cwd: string, max = 30): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (let t = turns.length - 1; t >= 0 && out.length < max; t -= 1) {
    const lines = turns[t].tools.split('\n')
    for (let l = lines.length - 1; l >= 0 && out.length < max; l -= 1) {
      const line = lines[l]
      const space = line.indexOf(' ')
      if (space < 0) continue
      const tool = line.slice(0, space)
      const rest = line.slice(space + 1).trim()
      const paths = ONE_FILE.has(tool) ? [rest] : PATCH.has(tool) ? rest.split(/\s+/).reverse() : []
      for (const raw of paths) {
        const path = raw && shown(cwd, raw)
        if (!path || seen.has(path)) continue
        seen.add(path)
        out.push(path)
        if (out.length >= max) break
      }
    }
  }
  return out
}
