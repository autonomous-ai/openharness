// picker.mjs — a file chooser that does not need the web view's help.
//
// The Harness desktop pane is a WKWebView, and on macOS it never opens the system file dialog for
// <input type="file">. The viewer runs on the person's machine, so it can list their files itself:
// the newest spreadsheets in Downloads, Desktop and Documents, a folder browser, and open-by-path.
//
// Limits, on purpose: only inside the home folder, never into a hidden folder (so ~/.ssh and
// ~/.config cannot be reached), only the file types the sheet can read, and nothing is read until
// the person picks it. A picked file is copied into the workspace like a dropped one.
import { readdirSync, statSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename, extname, sep } from 'node:path'

export const PICK_EXT = new Set(['.xlsx', '.csv', '.tsv', '.json', '.jsonl', '.ndjson'])
const SKIP = new Set(['node_modules', 'Library', 'Applications', '$RECYCLE.BIN'])
const RECENT_FOLDERS = ['Downloads', 'Desktop', 'Documents']

/** @param {{ home?: string, maxBytes?: number }} o  `home` can be set for tests (or JEV_SHEETS_HOME). */
export function createPicker({ home = process.env.JEV_SHEETS_HOME || homedir(), maxBytes = 32 * 1024 * 1024 } = {}) {
  let HOME
  try { HOME = realpathSync(home) } catch { HOME = resolve(home) }
  const inHome = (p) => p === HOME || p.startsWith(HOME + sep)
  const visible = (name) => !name.startsWith('.') && !SKIP.has(name)
  const tilde = (p) => (p === HOME ? '~' : p.startsWith(HOME + sep) ? '~' + p.slice(HOME.length) : p)
  // Reachable: inside home, never through a hidden folder, never the system's ~/Library.
  const okPath = (p) => { const parts = p.slice(HOME.length).split(sep).filter(Boolean); return inHome(p) && parts.every((s) => !s.startsWith('.')) && parts[0] !== 'Library' }
  const info = (path, st) => ({ path, name: basename(path), folder: tilde(dirname(path)), size: st.size, mtimeMs: Math.round(st.mtimeMs) })

  /** The newest readable spreadsheets in Downloads, Desktop and Documents (one folder deep). */
  function recent(limit = 40) {
    const out = []
    let denied = 0
    const scan = (dir, depth) => {
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES') denied++; return }
      for (const e of entries) {
        if (out.length > 5000 || !visible(e.name)) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) { if (depth > 0) scan(p, depth - 1) } else if (e.isFile() && PICK_EXT.has(extname(e.name).toLowerCase())) {
          try { const st = statSync(p); if (st.size > 0 && st.size <= maxBytes) out.push(info(p, st)) } catch { /* gone */ }
        }
      }
    }
    for (const f of RECENT_FOLDERS) scan(join(HOME, f), 1)
    out.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return { files: out.slice(0, limit), denied: denied > 0, home: '~' }
  }

  /** One folder: its sub-folders and the files the sheet can read. */
  function browse(dir) {
    let at
    try { at = realpathSync(resolve(expand(dir || '~'))) } catch { return { ok: false, error: 'that folder is not there' } }
    if (!okPath(at)) return { ok: false, error: 'only folders inside your home folder can be opened here' }
    let entries
    try { entries = readdirSync(at, { withFileTypes: true }) } catch (e) { return { ok: false, error: e.code === 'EPERM' || e.code === 'EACCES' ? 'this app is not allowed to read that folder. Allow it in System Settings, Privacy and Security, Files and Folders' : 'that folder cannot be read' } }
    const folders = [], files = []
    for (const e of entries) {
      if (!visible(e.name)) continue
      const p = join(at, e.name)
      if (e.isDirectory()) folders.push({ path: p, name: e.name })
      else if (e.isFile() && PICK_EXT.has(extname(e.name).toLowerCase())) { try { files.push(info(p, statSync(p))) } catch { /* gone */ } }
    }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    return { dir: at, shown: tilde(at), parent: at === HOME ? null : dirname(at), folders: folders.sort(byName).slice(0, 500), files: files.sort(byName).slice(0, 500) }
  }

  /** "~/Downloads/a b.csv", '/Users/me/a\ b.csv' or a quoted path, as typed or pasted. */
  function expand(raw) {
    let p = String(raw ?? '').trim().replace(/^file:\/\//, '')
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1)
    p = p.replace(/\\(.)/g, '$1') // a path dragged into a terminal escapes its spaces
    try { p = decodeURIComponent(p) } catch { /* not URL-encoded */ }
    if (p === '~') return HOME
    if (p.startsWith('~/')) return join(HOME, p.slice(2))
    return p
  }

  /** Read one picked file. Never throws: { name, buffer } or { error }. */
  function read(raw) {
    const typed = expand(raw)
    if (!typed) return { error: 'Type or paste the path of a file.' }
    let p
    try { p = realpathSync(resolve(typed)) } catch { return { error: `There is no file at ${typed}` } }
    if (!okPath(p)) return { error: 'Only files inside your home folder can be opened here. Copy the file there first, or give its path to the agent.' }
    if (!PICK_EXT.has(extname(p).toLowerCase())) return { error: 'Use an Excel .xlsx file, or a .csv, .tsv, .json or .jsonl file.' }
    let st
    try { st = statSync(p) } catch { return { error: 'That file cannot be read.' } }
    if (!st.isFile()) return { error: 'That is a folder, not a file.' }
    if (st.size > maxBytes) return { error: `That file is over ${Math.round(maxBytes / 1024 / 1024)} MB.` }
    try { return { name: basename(p), buffer: readFileSync(p) } } catch (e) { return { error: e.code === 'EPERM' || e.code === 'EACCES' ? 'This app is not allowed to read that file. Allow it in System Settings, Privacy and Security, Files and Folders.' : 'That file cannot be read.' } }
  }

  return { recent, browse, read }
}
