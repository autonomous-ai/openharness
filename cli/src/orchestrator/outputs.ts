import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parseVerdict } from '../dsh/verdict.js'
import { loopFolders } from './artifacts.js'
import { OrchestratorError, type Outputs, type Verdict } from './model.js'

export type OutputsCheck = { ok: true; files: string[] } | { ok: false; missing: string[] }
const MAX_DEPTH = 16, MAX_ENTRIES = 10_000, MAX_MATCHES = 64, MAX_VERDICT_BYTES = 1024 * 1024

/** `*` and `?` stay inside one folder; `**` crosses folders. Everything else is literal. */
export function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith('**/', i)) { source += '(?:[^/]+/)*'; i += 2 }
    else if (pattern.startsWith('**', i)) { source += '.*'; i += 1 }
    else if (pattern[i] === '*') source += '[^/]*'
    else if (pattern[i] === '?') source += '[^/]'
    else source += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

// Regular files only: symlinks are skipped (they could point outside the task), and so is
// inputs/, the read-only copies of upstream results.
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  let seen = 0
  // The loop check logs are never outputs, wherever a linked `.harness` or `.harness/loop` really puts them.
  const real = await realpath(root)
  const reserved = new Set((await loopFolders(real)).map(folder => relative(real, folder).split(sep).join('/')))
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const dirHandle = await opendir(dir)
    for await (const entry of dirHandle) {
      if (++seen > MAX_ENTRIES) throw new OrchestratorError('OUTPUTS_TOO_LARGE', `The task folder has more than ${MAX_ENTRIES} entries to search.`)
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isFile()) files.push(path)
      else if (entry.isDirectory() && depth < MAX_DEPTH && !(depth === 0 && entry.name === 'inputs') && !reserved.has(path)) await walk(join(dir, entry.name), path, depth + 1)
    }
  }
  await walk(root, '', 0)
  return files
}
/** The verdict an attempt left behind, reduced to what conditions compare. Read once, when the attempt ends. */
export async function readVerdictSnapshot(dir: string): Promise<Verdict | undefined> {
  try {
    const harnessDir = join(dir, '.harness'), file = join(harnessDir, 'verdict.json')
    // Only a real `.harness` directory and a regular, bounded `verdict.json` count: links are not followed.
    if (!(await lstat(harnessDir)).isDirectory()) return undefined
    const info = await lstat(file)
    if (!info.isFile() || info.size > MAX_VERDICT_BYTES) return undefined
    const buffer = await readFile(file)
    if (buffer.length > MAX_VERDICT_BYTES) return undefined
    const parsed = parseVerdict(buffer.toString('utf8'))
    return parsed ? { ready: parsed.ready, errors: parsed.errors, warnings: parsed.warnings } : undefined
  } catch { return undefined }
}
async function verdictReady(dir: string): Promise<boolean> { return (await readVerdictSnapshot(dir))?.ready === true }

export async function checkOutputs(cwd: string, outputs: Outputs): Promise<OutputsCheck> {
  const files = await listFiles(cwd)
  const matched = new Set<string>(), missing: string[] = []
  for (const pattern of outputs.files) {
    const expression = globToRegExp(pattern)
    const hits = files.filter(file => expression.test(file))
    if (!hits.length) missing.push(pattern)
    for (const hit of hits) matched.add(hit)
  }
  if (outputs.verdict === 'ready' && !await verdictReady(cwd)) missing.push('.harness/verdict.json with ready: true')
  if (missing.length) return { ok: false, missing }
  if (matched.size > MAX_MATCHES) return { ok: false, missing: [`at most ${MAX_MATCHES} output files (matched ${matched.size})`] }
  return { ok: true, files: [...matched].sort() }
}
