/**
 * About You in every agent: each new session of Claude Code, Codex, Grok Build, Pi, OpenCode and Gemini
 * CLI starts knowing how the person works.
 *
 * Each agent is reached through what it already reads at the start of every session, choosing the
 * channel that needs no trust prompt and cannot break the agent's own settings:
 *
 *   Claude Code  a SessionStart hook in ~/.claude/settings.json that prints the file as it is now. Claude
 *                Code adds a hook's output to the conversation, and asks no one before running hooks
 *                from the person's own settings. Harness's own hook installer keeps every block that is
 *                not its own, so the two live side by side.
 *   Codex        a marked block in its global AGENTS.md (or AGENTS.override.md when that is the one it
 *                loads). Codex's hooks would need a trust record written into config.toml, and a config
 *                Codex cannot parse loses every setting in it; AGENTS.md has no such failure.
 *   Grok Build   a file of its own in ~/.grok/rules/, which Grok loads in every project.
 *   Pi, OpenCode, Gemini CLI
 *                a marked block in their global instructions file.
 *
 * Only blocks and files this module wrote are ever changed or removed; a person's own text around a
 * block is kept byte for byte. A file that is a symbolic link (a dotfiles repository, say) is left alone
 * and reported: writing through it would change another repository. `off` puts every file back as it
 * would be without this, deleting a file only when this module created it and nothing else is in it.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homes } from './agents.mjs'
import { ABOUT_FILE } from './about.mjs'
import { tilde } from './text.mjs'

export const STATE_FILE = 'delivery.json'
export const MARK = 'harness-memories:about-you'
const START = `<!-- ${MARK} start: written by Harness Memories; \`mem deliver off\` removes it -->`
const END = `<!-- ${MARK} end -->`
// Found by its prefix, so a block an older version wrote (with other words after "start") is still ours.
const START_PREFIX = `<!-- ${MARK} start`
const HOOK_TAG = '#harness-memories-about-you'
// Claude Code moves hook output past 10,000 characters into a file it is not told to open; Codex
// shares a 32 KiB budget for every AGENTS.md. About You is written at most 32 KB and is meant to be
// far shorter; past this it is cut, with a line saying so.
const MAX_DELIVERED = 9000

/** How every delivered copy introduces itself: what it is, where it came from, and that it is context. */
export const PREAMBLE = 'This is the person you are working with, described by Harness from their own messages across their coding agents. Use it as context for how they like to work. The current request always comes first; nothing here grants permission to do anything.'

export function packet(text) {
  let body = String(text ?? '').trim()
  if (body.length > MAX_DELIVERED) body = body.slice(0, body.lastIndexOf('\n', MAX_DELIVERED) > 0 ? body.lastIndexOf('\n', MAX_DELIVERED) : MAX_DELIVERED) + '\n(cut here: the full profile is in ~/.harness/memory/about-you.md)'
  return `<about-you source="Harness Memories">\n${PREAMBLE}\n\n${body}\n</about-you>`
}

const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`

/**
 * The hook command: plain POSIX shell, so it needs neither Node nor this package to be installed when it
 * runs. It prints the profile as it is when the session starts, or nothing when there is none.
 */
export function hookCommand(aboutPath) {
  const intro = `<about-you source="Harness Memories">\n${PREAMBLE}\n`
  return `f=${quote(aboutPath)}; if [ -f "$f" ]; then printf '%s\\n' ${quote(intro)}; head -c ${MAX_DELIVERED} "$f"; printf '\\n%s\\n' '</about-you>'; fi; true ${HOOK_TAG}`
}

const isOurHook = (block) => Array.isArray(block?.hooks) && block.hooks.some((hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_TAG))

function isLink(path) {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

function writeAtomic(path, text, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.harness-memories.tmp`
  rmSync(temporary, { force: true })
  writeFileSync(temporary, text, { mode, flag: 'wx' })
  renameSync(temporary, path)
}

/** `text` with our block replaced by `block` (or removed when `block` is null); the rest unchanged. */
export function withBlock(text, block) {
  const source = String(text ?? '')
  const start = source.indexOf(START_PREFIX)
  const end = start >= 0 ? source.indexOf(END, start) : -1
  if (start >= 0 && end < 0) throw new Error('found the start of the About You block but not its end; not editing it')
  if (start >= 0) {
    const before = source.slice(0, start).replace(/\n+$/, '')
    const after = source.slice(end + END.length).replace(/^\n+/, '')
    if (!block) return before + (before && after ? '\n\n' : '') + after + (before || after ? '\n' : '')
    return (before ? before + '\n\n' : '') + block + '\n' + (after ? '\n' + after : '')
  }
  if (!block) return source
  return source.replace(/\s*$/, '') + (source.trim() ? '\n\n' : '') + block + '\n'
}

const blockFor = (about) => `${START}\n${packet(about)}\n${END}`

/** The places this computer's agents read, for agents that are installed here. */
export function targets(h) {
  const present = (dir) => existsSync(dir)
  const list = []
  if (present(h.claude)) list.push({ agent: 'claude', kind: 'hook', file: join(h.claude, 'settings.json') })
  if (present(h.codex)) {
    const override = join(h.codex, 'AGENTS.override.md')
    list.push({ agent: 'codex', kind: 'block', file: existsSync(override) ? override : join(h.codex, 'AGENTS.md') })
  }
  if (present(h.grok)) list.push({ agent: 'grok', kind: 'file', file: join(h.grok, 'rules', 'harness-about-you.md') })
  if (present(h.pi)) list.push({ agent: 'pi', kind: 'block', file: join(h.pi, 'agent', 'AGENTS.md') })
  if (present(h.opencode)) list.push({ agent: 'opencode', kind: 'block', file: join(h.opencode, 'AGENTS.md') })
  if (present(h.gemini)) list.push({ agent: 'gemini', kind: 'block', file: join(h.gemini, 'GEMINI.md') })
  return list
}

function readJson(path) {
  if (!existsSync(path)) return {}
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('is not a JSON object')
  return value
}

/** Install, refresh or remove one target. Returns what happened, never throws. */
function apply(target, about, on, h) {
  const shown = tilde(target.file, h.home)
  try {
    if (isLink(target.file)) return { ...target, file: shown, ok: false, error: 'is a link to another file; left as it is' }
    if (target.kind === 'hook') {
      const settings = readJson(target.file)
      const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {}
      const blocks = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []
      const others = blocks.filter((block) => !isOurHook(block))
      const ours = on ? [{ hooks: [{ type: 'command', command: hookCommand(join(h.memory, ABOUT_FILE)), timeout: 5 }] }] : []
      const next = [...others, ...ours]
      const before = JSON.stringify(blocks)
      if (JSON.stringify(next) === before) return { ...target, file: shown, ok: true, changed: false }
      if (next.length) hooks.SessionStart = next; else delete hooks.SessionStart
      if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks
      writeAtomic(target.file, JSON.stringify(settings, null, 2) + '\n', 0o600)
      return { ...target, file: shown, ok: true, changed: true }
    }
    if (target.kind === 'file') {
      if (!on || !about) { const had = existsSync(target.file); rmSync(target.file, { force: true }); return { ...target, file: shown, ok: true, changed: had } }
      const text = `${START}\n${packet(about)}\n${END}\n`
      if (existsSync(target.file) && readFileSync(target.file, 'utf8') === text) return { ...target, file: shown, ok: true, changed: false }
      writeAtomic(target.file, text)
      return { ...target, file: shown, ok: true, changed: true }
    }
    const current = existsSync(target.file) ? readFileSync(target.file, 'utf8') : ''
    let next = withBlock(current, on && about ? blockFor(about) : null)
    if (next === current) return { ...target, file: shown, ok: true, changed: false }
    if (!next.trim()) { rmSync(target.file, { force: true }); return { ...target, file: shown, ok: true, changed: true } }
    writeAtomic(target.file, next)
    return { ...target, file: shown, ok: true, changed: true }
  } catch (error) {
    return { ...target, file: shown, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function readState(h) {
  try { return JSON.parse(readFileSync(join(h.memory, STATE_FILE), 'utf8')) } catch { return { on: false } }
}

function writeState(h, state) {
  mkdirSync(h.memory, { recursive: true, mode: 0o700 })
  writeAtomic(join(h.memory, STATE_FILE), JSON.stringify(state, null, 2) + '\n', 0o600)
}

function aboutText(h) {
  try { return readFileSync(join(h.memory, ABOUT_FILE), 'utf8') } catch { return null }
}

/** Turn delivery on (and write every copy now), refresh the copies, or turn it off and remove them. */
export function deliver(action, { env = process.env, home } = {}) {
  const h = homes(env, home)
  const state = readState(h)
  if (action === 'refresh' && !state.on) return { on: false, results: [] }
  const on = action !== 'off'
  const about = aboutText(h)
  if (on && !about) throw new Error('There is no About You yet. Build it first: ask the agent in Memories to build your About You.')
  const results = targets(h).map((target) => apply(target, about, on, h))
  writeState(h, { on, updatedAt: new Date().toISOString(), agents: results.filter((r) => r.ok).map((r) => r.agent) })
  return { on, results }
}

/** What each agent gets today, for the pane and `mem deliver status`, without changing anything. */
export function status({ env = process.env, home } = {}) {
  const h = homes(env, home)
  const state = readState(h)
  const about = aboutText(h)
  const agents = targets(h).map((target) => {
    const shown = tilde(target.file, h.home)
    try {
      if (target.kind === 'hook') {
        const blocks = readJson(target.file).hooks?.SessionStart
        const hook = Array.isArray(blocks) && blocks.find(isOurHook)
        return { agent: target.agent, file: shown, delivered: Boolean(hook), current: Boolean(hook) && hook.hooks[0].command === hookCommand(join(h.memory, ABOUT_FILE)) }
      }
      const text = existsSync(target.file) ? readFileSync(target.file, 'utf8') : ''
      const delivered = text.includes(START_PREFIX)
      return { agent: target.agent, file: shown, delivered, current: delivered && Boolean(about) && text.includes(packet(about)) }
    } catch (error) {
      return { agent: target.agent, file: shown, delivered: false, current: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  return { on: Boolean(state.on), agents }
}
