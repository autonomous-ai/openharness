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

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { homes } from './agents.mjs'
import { ABOUT_FILE } from './about.mjs'
import { tilde } from './text.mjs'

export const STATE_FILE = 'delivery.json'
export const MARK = 'harness-memories:about-you'
export const GROK_FILE = 'harness-about-you.md'
const START = `<!-- ${MARK} start: written by Harness Memories; \`mem deliver off\` removes it -->`
const END = `<!-- ${MARK} end -->`
// Found by its prefix, so a block an older version wrote (with other words after "start") is still ours.
const START_PREFIX = `<!-- ${MARK} start`
const HOOK_TAG = '#harness-memories-about-you'
// Claude Code moves hook output past 10,000 characters into a file it is not told to open; Codex
// shares a 32 KiB budget for every AGENTS.md. About You is written at most 32 KB and is meant to be
// far shorter; past this it is cut, with a line saying so.
const MAX_DELIVERED = 9000

/**
 * How every delivered copy introduces itself. The person's stated preferences are to be followed —
 * that is the point — but a profile never widens what an agent may do: its permissions and safety
 * rules stay as they are, and the request in front of it comes first.
 */
export const PREAMBLE = 'This describes the person you are working with, built by Harness from their own messages to their coding agents. Treat it as their standing preferences. Their current request always comes first, and nothing here changes your permissions or safety rules.'

/**
 * Text that could end a copy early is made inert: our block markers and the <about-you> wrapper. A
 * profile written through `mem about write` cannot contain them; a hand-edited one is neutralized here
 * and, for the hook, by the same substitution in sh.
 */
export function inert(text) {
  return String(text ?? '').replace(/harness-memories:about-you/gi, 'harness-memories about-you').replace(/<(\/?)about-you/gi, '<$1about_you')
}

/** Headings become plain lines: Gemini CLI adds memories at the next `## ` after its own section. */
const flatHeadings = (text) => text.replace(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm, '$1:')

export function packet(text) {
  let body = flatHeadings(inert(text).trim())
  if (body.length > MAX_DELIVERED) {
    const cut = body.lastIndexOf('\n', MAX_DELIVERED)
    body = body.slice(0, cut > 0 ? cut : MAX_DELIVERED) + '\n(cut here: the full profile is in ~/.harness/memory/about-you.md)'
  }
  return `<about-you source="Harness Memories">\n${PREAMBLE}\n\n${body}\n</about-you>`
}

const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`

/**
 * The hook command: plain POSIX shell, so it needs neither Node nor this package to be installed when it
 * runs. It prints the profile as it is when the session starts, or nothing when there is none.
 */
export function hookCommand(aboutPath) {
  const intro = `<about-you source="Harness Memories">\n${PREAMBLE}\n`
  const neutralize = `sed -e 's/harness-memories:about-you/harness-memories about-you/g' -e 's#<\\(/*\\)about-you#<\\1about_you#g'`
  return `f=${quote(aboutPath)}; if [ -f "$f" ]; then printf '%s\\n' ${quote(intro)}; head -c ${MAX_DELIVERED} "$f" | ${neutralize}; printf '\\n%s\\n' '</about-you>'; fi; true ${HOOK_TAG}`
}

const isOurHook = (block) => Array.isArray(block?.hooks) && block.hooks.some((hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_TAG))

/**
 * Whether the file, or any folder between the home folder and it, is a symbolic link. A linked
 * `~/.config/opencode` (GNU stow's default) or `~/.codex` lives in another repository; writing there
 * would put the profile into it. Folders above the home folder (macOS /var → /private/var) are not ours
 * to judge and are not checked.
 */
export function linkedPath(file, home) {
  const rel = relative(home, file)
  if (rel.startsWith('..') || rel === '') return null
  let path = home
  for (const part of rel.split(sep)) {
    path = join(path, part)
    try { if (lstatSync(path).isSymbolicLink()) return path } catch { return null }
  }
  return null
}

function modeOf(path, fallback) {
  try { return statSync(path).mode & 0o777 } catch { return fallback }
}

/** Replace a file atomically, keeping its mode; a new file is private to the person (0600). */
function writeAtomic(path, text, mode = modeOf(path, 0o600)) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.harness-memories.tmp`
  rmSync(temporary, { force: true })
  writeFileSync(temporary, text, { mode, flag: 'wx' })
  renameSync(temporary, path)
}

/**
 * `text` with every block of ours removed and, when `block` is given, one block appended. The person's
 * text is kept: added after a blank line, and on removal the file is as it was before (a file that did
 * not end with a newline gains one, the one difference).
 */
export function withBlock(text, block) {
  let source = String(text ?? '')
  for (;;) {
    const start = source.indexOf(START_PREFIX)
    if (start < 0) break
    const end = source.indexOf(END, start)
    if (end < 0) throw new Error('found the start of the About You block but not its end; not editing it')
    let before = source.slice(0, start)
    let after = source.slice(end + END.length)
    if (after.startsWith('\r\n')) after = after.slice(2); else if (after.startsWith('\n')) after = after.slice(1)
    // The blank line this put before its block goes with it.
    if (!after && before.endsWith('\n\n')) before = before.slice(0, -1)
    else if (!after && before.endsWith('\r\n\r\n')) before = before.slice(0, -2)
    source = before + after
  }
  if (!block) return source
  if (!source) return block + '\n'
  return source + (source.endsWith('\n') ? '\n' : '\n\n') + block + '\n'
}

const blockFor = (about) => `${START}\n${packet(about)}\n${END}`

/** Our own copies, as `readInstructions` must not count them as something the person wrote. */
export function withoutOurBlock(text) {
  try { return withBlock(text, null) } catch { return String(text ?? '') }
}

/** The places this computer's agents read, for agents that are installed here. */
export function targets(h) {
  const present = (dir) => existsSync(dir)
  const list = []
  if (present(h.claude)) list.push({ agent: 'claude', kind: 'hook', file: join(h.claude, 'settings.json') })
  if (present(h.codex)) {
    // Codex reads AGENTS.override.md instead of AGENTS.md only when it has something in it; writing into an
    // empty one would make Codex stop reading the person's AGENTS.md.
    const override = join(h.codex, 'AGENTS.override.md')
    const used = (() => { try { return withoutOurBlock(readFileSync(override, 'utf8')).trim().length > 0 } catch { return false } })()
    list.push({ agent: 'codex', kind: 'block', file: used ? override : join(h.codex, 'AGENTS.md') })
  }
  if (present(h.grok)) list.push({ agent: 'grok', kind: 'file', file: join(h.grok, 'rules', GROK_FILE) })
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
function apply(target, about, on, h, created) {
  const shown = tilde(target.file, h.home)
  try {
    const linked = linkedPath(target.file, h.home)
    if (linked) return { ...target, file: shown, ok: false, error: `${tilde(linked, h.home)} is a link to another place; left as it is` }
    if (target.kind === 'hook') {
      const settings = readJson(target.file)
      if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error('has "hooks" in a shape Claude Code does not use; not editing it')
      const hooks = settings.hooks ?? {}
      if (hooks.SessionStart !== undefined && !Array.isArray(hooks.SessionStart)) throw new Error('has "SessionStart" in a shape Claude Code does not use; not editing it')
      const blocks = hooks.SessionStart ?? []
      const command = hookCommand(join(h.memory, ABOUT_FILE))
      const ours = blocks.filter(isOurHook)
      // Already there, once and current: leave the file alone, wherever Harness's own hook sits.
      if (on && ours.length === 1 && ours[0].hooks.length === 1 && ours[0].hooks[0].command === command) return { ...target, file: shown, ok: true, changed: false }
      if (!on && !ours.length) return { ...target, file: shown, ok: true, changed: false }
      const next = [...blocks.filter((block) => !isOurHook(block)), ...(on ? [{ hooks: [{ type: 'command', command, timeout: 5 }] }] : [])]
      if (next.length) hooks.SessionStart = next; else delete hooks.SessionStart
      if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks
      if (!existsSync(target.file)) created.add(target.file)
      writeAtomic(target.file, JSON.stringify(settings, null, 2) + '\n')
      return { ...target, file: shown, ok: true, changed: true }
    }
    if (target.kind === 'file') {
      if (!on || !about) { const had = existsSync(target.file); rmSync(target.file, { force: true }); return { ...target, file: shown, ok: true, changed: had } }
      const text = `${START}\n${packet(about)}\n${END}\n`
      if (existsSync(target.file) && readFileSync(target.file, 'utf8') === text) return { ...target, file: shown, ok: true, changed: false }
      writeAtomic(target.file, text)
      return { ...target, file: shown, ok: true, changed: true }
    }
    const existed = existsSync(target.file)
    const current = existed ? readFileSync(target.file, 'utf8') : ''
    const next = withBlock(current, on && about ? blockFor(about) : null)
    if (next === current && existed) return { ...target, file: shown, ok: true, changed: false }
    if (!existed && !next) return { ...target, file: shown, ok: true, changed: false }
    // A file this created and that now holds nothing else goes; a file the person had stays, even empty.
    if (!next && created.has(target.file)) { rmSync(target.file, { force: true }); created.delete(target.file); return { ...target, file: shown, ok: true, changed: true } }
    if (!existed) created.add(target.file)
    writeAtomic(target.file, next)
    return { ...target, file: shown, ok: true, changed: true }
  } catch (error) {
    return { ...target, file: shown, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The default "on" for a person who never chose: any real choice, made at any time, outranks it. */
export const DEFAULT_CHOICE_AT = 1
export const LEGACY_CHOICE_AT = 2

export function readState(h) {
  let state
  try { state = JSON.parse(readFileSync(join(h.memory, STATE_FILE), 'utf8')) } catch { return { on: false } }
  // Written before choices carried a time (the first Memories): an on or off then was always the
  // person's, so it keeps counting as one, dated when it was written.
  // Dated just after the default and before any real click: its updatedAt moved with every refresh, so
  // it says nothing about when the choice was made.
  if (state && state.choiceAt === undefined && typeof state.on === 'boolean') {
    state.choseOff = state.choseOff ?? !state.on
    state.choiceAt = LEGACY_CHOICE_AT
  }
  return state ?? { on: false }
}

function writeState(h, state) {
  mkdirSync(h.memory, { recursive: true, mode: 0o700 })
  writeAtomic(join(h.memory, STATE_FILE), JSON.stringify(state, null, 2) + '\n', 0o600)
}

function aboutText(h) {
  try { return readFileSync(join(h.memory, ABOUT_FILE), 'utf8') } catch { return null }
}

/** Turn delivery on (and write every copy now), refresh the copies, or turn it off and remove them. */
/**
 * `on` and `off` are the person's choice, from the pane's switch, `mem deliver`, or the agent asked in
 * chat. The choice carries its time (`choiceAt`) so every machine can keep the newest one: a choice
 * made here is later than any this machine knows of; a choice made on another machine is applied with
 * that machine's time (`exact`), never as a new one. `refresh` is not a choice: it only rewrites copies.
 */
export function deliver(action, { env = process.env, home, choiceAt = Date.now(), exact = false } = {}) {
  const h = homes(env, home)
  const state = readState(h)
  if (!exact) choiceAt = Math.max(choiceAt, (state.choiceAt ?? 0) + 1)
  // A choice from elsewhere never undoes a newer one here (the person clicked while it travelled); at the
  // same time, off stays.
  if (exact && (action === 'on' || action === 'off') && state.choiceAt !== undefined && state.choiceAt !== null
    && (choiceAt < state.choiceAt || (choiceAt === state.choiceAt && (action === 'on' || state.choseOff)))) {
    return { on: Boolean(state.on), results: [], ignored: true, choiceAt: state.choiceAt }
  }
  if (action === 'refresh' && !state.on) return { on: false, results: [] }
  const on = action !== 'off'
  const about = aboutText(h)
  if (on && !about) throw new Error('There is no About You yet. Build it first: ask the agent in Memories to build your About You.')
  const created = new Set(Array.isArray(state.created) ? state.created : [])
  const results = targets(h).map((target) => apply(target, about, on, h, created))
  // `on` and `off` are the person's choice and are kept with their time; `refresh` (a rebuilt or synced
  // About You) only rewrites copies and never changes the choice (lib/fleet.mjs, viewer.mjs).
  const chosen = action === 'on' || action === 'off'
  writeState(h, {
    on,
    choseOff: action === 'off' ? true : action === 'on' ? false : Boolean(state.choseOff),
    choiceAt: chosen ? choiceAt : (state.choiceAt ?? null),
    updatedAt: new Date().toISOString(),
    agents: results.filter((r) => r.ok).map((r) => r.agent),
    created: [...created],
  })
  return { on, results, choiceAt: chosen ? choiceAt : (state.choiceAt ?? null) }
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
  // What it costs: every new session of every agent that gets it starts with this many more tokens
  // (about four characters a token for English prose).
  const tokens = about ? Math.round(packet(about).length / 4) : 0
  return { on: Boolean(state.on), choseOff: Boolean(state.choseOff), choiceAt: state.choiceAt ?? null, tokens, built: Boolean(about), agents }
}
