/** Plain project-file helpers shared by core handoffs and optional publishers. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function isPlainFile(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() } catch { return false }
}

export function isPlainDir(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink() } catch { return false }
}

export function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

/** Add one exclude entry without following a linked file or parent directory. */
export function addExcludeEntry(file: string, entry: { pattern: string; comment: string }): string | null {
  if (isLink(file) || isLink(join(file, '..'))) return null
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (text.split('\n').some((line) => line.trim() === entry.pattern)) return file
  mkdirSync(join(file, '..'), { recursive: true })
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# ${entry.comment}\n${entry.pattern}\n`)
  return file
}
