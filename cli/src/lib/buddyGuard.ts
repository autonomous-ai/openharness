import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { PASTE_DROPS_DIR } from './pasteDropFiles.js'

/** Where a Buddy's guard reads what its person sent it (the host's list for this Buddy), and where Harness downloads chat
 *  files to (lib/pasteDropFiles.ts). */
export interface BuddyReads { file: string; drops: string }
/** A listed file or link lasts as long as Harness keeps a download (lib/pasteDropFiles.ts): a day. */
const KEPT_MS = 24 * 60 * 60 * 1000

/**
 * A Buddy's guard: the Claude Code PreToolUse hook its folder's settings run before every tool call (lib/swarmSkills.ts).
 *
 * A Buddy never changes anything, and it must never stall on a permission prompt nobody at its terminal answers (Ken,
 * 10-29). Asking mode stalled on every read command; full permissions would let Bash push or open pull requests with its
 * person's own GitHub login, which the Edit and Write deny rules do not stop. So it launches in Claude Code's dontAsk
 * mode, and this guard answers every call: allow for its read tools, its Super Tab commands and a fixed set of read
 * commands, each one plain command, and deny for everything else. Its deny outranks any allow rule in the person's own
 * settings, which dontAsk alone would honour.
 *
 * A Bash command is allowed only as words the guard can read exactly as the shell will: unquoted letters, digits and
 * `_-./:=,@%+`, single-quoted text, and double-quoted text without `$`, a backtick, `\` or `!`. Anything else (pipes,
 * redirects, `;`, `&`, `$()`, globs, braces, `~`, comments, a newline) refuses the whole command, so a read command cannot
 * carry another one. The read commands' own ways to write or run something are refused too: git's `--output`, `-O`/
 * `--open-files-in-pager` and `--ext-diff` (git takes any unique prefix of a long option, so prefixes too), gh's `--web`,
 * and rg's `--pre`, `--pre-glob`, `-z` and `--hostname-bin`, which runs a program (rg 14.1.1, tried).
 *
 * It confines the Buddy's own reads to its folder (security review 2 of #2092): the machine is its person's, the folder is
 * the project. That is the whole claim. Files another local process places in the folder, by link, hard link or copy, are
 * outside it: the guard judges a path when it answers and Claude Code opens it afterwards, so a link swapped in between,
 * or a hard link (whose real path is its name in the folder), reads what that process put there (review 4 of #2092, the
 * Lead's ruling). The Buddy itself has no command that writes, so it can place none of them.
 * Read, Grep, Glob and LS take paths there only, by real path, so a link out is out. Each part of a Bash word that could
 * be a path (itself, after "=" or ":", and after each letter of a short option, as -S/x or -fout/x glue a value on) is
 * refused when it is absolute, has a ".." part, or by its real path as the command runs leaves the folder: a link a pull
 * brings after launch included, and nothing in the folder is removed for it (review 3 of #2092, Lead). So are the read
 * commands' ways to follow links as they walk (grep -R/-S/-O, rg -L, ls -L), gh's -R/--repo (any repository its person
 * can read) and git's --no-index. grep's and rg's long options are allowlists, by whole name: both are bundled with Claude
 * Code, and a newer build must not add one that follows links or runs a program unnoticed.
 * Its Super Tab commands are a Buddy's own (status, messages, message, decisions, post, propose, help) as the pane it runs
 * in identifies it: never --agent, --port or --machine. Nothing runs on: no background shell, no tail -f.
 *
 * Outside its folder it reads only what its person sent it in their Buddy chat (Tony, 10-30: his Buddy could open neither
 * the screenshot he sent it nor an Artifact he linked). The host lists those for this Buddy alone (`allowBuddyReads`
 * below, superTabs/host.ts), out of the project, so no commit or pull can add to the list. Read opens a listed file by the
 * exact path the Buddy was handed, while it is still the one file Harness downloaded there; the Artifact tool reads a
 * listed link with its read action alone.
 *
 * Plain JavaScript with node's own modules only, written into the Buddy's folder with that folder's real path and run by
 * Harness's node: the tests run this exact text (lib/buddyGuard.spec.ts, and Claude Code itself in
 * lib/buddyGuard.claude.spec.ts).
 */
export const buddyGuardSource = (root: string, reads: BuddyReads): string => String.raw`#!/usr/bin/env node
// A Buddy's guard, written by Harness (cli/src/lib/buddyGuard.ts). Do not edit: Harness writes it again at each launch.
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

// The Buddy's folder, as its real path: what it reads stays in it.
const ROOT = ${JSON.stringify(root)}
// What its person sent it in their Buddy chat, as the host lists it, and the folder Harness downloads chat files to.
const READS = ${JSON.stringify(reads.file)}
const DROPS = ${JSON.stringify(reads.drops)}
const KEPT_MS = ${KEPT_MS}
const TOOLS = new Set(['TodoWrite', 'ToolSearch'])
const READERS = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'grep', 'pwd'])
const GIT = new Set(['grep', 'log', 'show', 'diff', 'blame', 'status'])
const GH = { issue: new Set(['view', 'list']), pr: new Set(['view', 'list', 'diff']) }
const GIT_LONG = ['output', 'open-files-in-pager', 'ext-diff']
// rg's long options likewise, so a newer bundled rg cannot add one that follows links or runs a program unnoticed
// (security re-check of #2092): only these, each by its whole name. --pre, --pre-glob, --search-zip, --hostname-bin and
// --follow are not among them.
const RG_LONG = new Set(['line-number', 'no-line-number', 'ignore-case', 'smart-case', 'case-sensitive', 'fixed-strings',
  'word-regexp', 'line-regexp', 'regexp', 'count', 'count-matches', 'files-with-matches', 'files-without-match', 'glob',
  'iglob', 'type', 'type-not', 'context', 'after-context', 'before-context', 'max-count', 'max-depth', 'invert-match',
  'only-matching', 'no-filename', 'with-filename', 'heading', 'no-heading', 'hidden', 'no-ignore', 'column', 'vimgrep',
  'json', 'color', 'trim', 'multiline', 'sort'])
// A Buddy's grep is Claude Code's shell function around its built-in ugrep (2.1.312), whose long options go much further
// than grep's: --dereference-files follows links while it walks, and others filter through commands, read configs, page
// or index (security re-check of #2092). Only these, each by its whole name, with or without =VALUE.
const GREP_LONG = new Set(['include', 'exclude', 'exclude-dir', 'include-dir', 'line-number', 'ignore-case', 'smart-case',
  'recursive', 'count', 'files-with-matches', 'files-without-match', 'word-regexp', 'line-regexp', 'fixed-strings',
  'extended-regexp', 'basic-regexp', 'perl-regexp', 'context', 'after-context', 'before-context', 'max-count',
  'invert-match', 'only-matching', 'no-filename', 'with-filename', 'color', 'colour', 'regexp', 'text', 'no-messages',
  'quiet', 'silent'])
// A Buddy's own Super Tab commands: reading its chats and posting in its own, and its owner's proposal. The pane it runs in
// says who it is (superTabs/command.ts), so it never names an agent, a port or a machine.
const SUPER_TAB = new Set(['status', 'messages', 'message', 'decisions', 'post', 'propose', 'help'])
const MAY = 'A Buddy only reads, so this was refused and nobody will be asked. Read the code with Read, Grep and Glob. ' +
  'In the shell, run one plain command at a time (no pipes, redirects, ;, &&, $() or globs): git grep, log, show, diff, ' +
  'blame or status; gh issue view or list; gh pr view, list or diff; ls, cat, rg, head, tail, wc or grep; or harness super-tab.'

// The command's words, or null when the shell could read it any other way.
function words(command) {
  const out = []
  let word = null
  for (let i = 0; i < command.length;) {
    const c = command[i]
    if (c === ' ' || c === '\t') { if (word !== null) out.push(word); word = null; i++; continue }
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return null
      word = (word ?? '') + command.slice(i + 1, end); i = end + 1; continue
    }
    if (c === '"') {
      let end = i + 1
      while (end < command.length && command[end] !== '"') {
        if ('$\x60\\!'.includes(command[end])) return null
        end++
      }
      if (end >= command.length) return null
      word = (word ?? '') + command.slice(i + 1, end); i = end + 1; continue
    }
    // zsh expands a word that starts with = to a command's path.
    if (!/[A-Za-z0-9_\-.\/:=,@%+]/.test(c) || (c === '=' && word === null)) return null
    word = (word ?? '') + c; i++
  }
  if (word !== null) out.push(word)
  return out
}

// Whether [path] is in the Buddy's folder: by the real path of the file, or of its nearest folder that exists, so a
// link out of the folder, or a ".." out of it, is out.
function inside(path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return false
  let at = resolve(ROOT, path), rest = ''
  for (;;) {
    try {
      const real = join(realpathSync(at), rest)
      return real === ROOT || real.startsWith(ROOT + sep)
    } catch { /* not there: its folder decides */ }
    if (dirname(at) === at) return false
    rest = rest ? join(basename(at), rest) : basename(at)
    at = dirname(at)
  }
}

// Whether [part], read as a path from the folder, leaves it: absolute (the machine's files, /dev), a ".." part, or, by its
// real path when the guard answers, a link out (one a pull brought after launch too), a broken link, or a path under one.
// What another process changes after that answer is outside the guard (see the top of this file).
// A word that names nothing there (a pattern, a revision) is judged by the folder it would be in.
function escapes(part) {
  if (!part) return false
  if (isAbsolute(part) || part.split('/').includes('..')) return true
  const full = resolve(ROOT, part)
  try { lstatSync(full) } catch { return !inside(part) }
  try {
    const real = realpathSync(full)
    return !(real === ROOT || real.startsWith(ROOT + sep))
  } catch { return true }
}

// A word that names a place out of the folder: itself, what follows "=" or ":" (--file=/x, HEAD:../x), and for a short
// option what follows each of its letters, since a value may be glued on (-S/x, -f../x, -fout/x). A range such as
// main..HEAD has no ".." part.
const outward = (word) => word.split(/[=:]/).some(escapes)
  || (/^-[^-]/.test(word) && [...word].some((_, at) => at >= 2 && escapes(word.slice(at))))

const short = (word) => /^-[^-]/.test(word)
// A long option naming one of these, or a unique prefix of one: git takes either.
const longNames = (word, names) => word.startsWith('--') && names.some((name) => {
  const given = word.slice(2).split('=')[0]
  return given.length > 0 && name.startsWith(given)
})

// The list's [kind] entries from the last day, as long as Harness keeps a download; none when it cannot be read.
function listed(kind) {
  try {
    const entries = JSON.parse(readFileSync(READS, 'utf8'))[kind], now = Date.now()
    return Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object' && Number.isFinite(entry.at)
      && now - entry.at < KEPT_MS) : []
  } catch { return [] }
}

// Whether [path] is a file its person sent: listed by that exact path, in the downloads folder, and still the one file
// Harness downloaded there (its device, inode and size), with no other name. A link, a hard link (a second name for it)
// or another file put in its place would read something its person did not send.
function attached(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || dirname(path) !== DROPS) return false
  const file = listed('files').find((entry) => entry.path === path)
  if (!file) return false
  try {
    const stat = lstatSync(path, { bigint: true })
    return stat.isFile() && stat.nlink === 1n && String(stat.dev) === file.dev && String(stat.ino) === file.ino
      && String(stat.size) === file.size && realpathSync(path) === join(realpathSync(DROPS), basename(path))
  } catch { return false }
}

// A claude.ai Artifact link as the host lists it (artifactLink in lib/buddyGuard.ts), or null: https, claude.ai or
// preview.claude.ai, an artifact's own path, and nothing more (no port, user, query or fragment).
function artifactLink(text) {
  if (typeof text !== 'string') return null
  let url
  try { url = new URL(text) } catch { return null }
  const path = /^\/((?:code\/)?artifact\/[A-Za-z0-9_-]{1,100})\/?$/.exec(url.pathname)
  if (!path || url.protocol !== 'https:' || !['claude.ai', 'preview.claude.ai'].includes(url.hostname) || url.port || url.username
    || url.password || url.search || url.hash) return null
  return 'https://' + url.hostname + '/' + path[1]
}

// Claude Code's Artifact tool reads a claude.ai link as its person's own Claude sign-in: its read action alone, of a link
// its person sent, with no file of it saved to a folder of the Buddy's choosing and nothing published, listed or removed.
const ARTIFACT_READ = new Set(['action', 'url', 'prompt', 'page'])
function artifactAllowed(tool) {
  if (tool.action !== 'read' || !Object.keys(tool).every((key) => ARTIFACT_READ.has(key))) return false
  if ((tool.prompt !== undefined && typeof tool.prompt !== 'string') || (tool.page !== undefined && typeof tool.page !== 'boolean')) return false
  const link = artifactLink(tool.url)
  return link !== null && listed('links').some((entry) => entry.url === link)
}

// harness super-tab [--tab ID] ACTION ...: only a Buddy's actions, and an --attach only from its folder.
function superTabAllowed(rest) {
  let i = 0
  while (rest[i] === '--tab') i += 2
  if (i > rest.length || !SUPER_TAB.has(rest[i])) return false
  return !rest.slice(i + 1).some((word, at, after) => (word === '--attach' && (after[at + 1] === undefined || outward(after[at + 1])))
    || ['--agent', '--port', '--machine'].includes(word))
}

function bashAllowed(command) {
  if (typeof command !== 'string') return false
  const w = words(command)
  if (!w || w.length === 0) return false
  const [name, sub, verb] = w
  const rest = w.slice(1)
  if (name === 'harness') return sub === 'super-tab' && superTabAllowed(w.slice(2))
  if (rest.some(outward)) return false
  // Nothing that runs on: a background shell, or tail following a file.
  if (name === 'tail') return !rest.some((word) => longNames(word, ['follow']) || (short(word) && /[fF]/.test(word)))
  // Nor following links while walking the folder: grep -R/-S/-O, rg -L, ls -L; nor ugrep's query screen (-Q).
  if (name === 'grep') {
    return !rest.some((word) => (word.startsWith('--') && word !== '--' && !GREP_LONG.has(word.slice(2).split('=')[0]))
      || (short(word) && /[RSOQ]/.test(word)))
  }
  if (name === 'ls') return !rest.some((word) => longNames(word, ['dereference']) || (short(word) && word.includes('L')))
  if (READERS.has(name)) return true
  if (name === 'git') {
    return GIT.has(sub) && !rest.some((word) => longNames(word, GIT_LONG) || word === '--no-index' || (short(word) && word.includes('O')))
  }
  if (name === 'gh') {
    // Its own project's issues and pull requests only: -R/--repo would read any repository its person can.
    return Object.hasOwn(GH, sub) && GH[sub].has(verb)
      && !rest.some((word) => word === '--web' || word.startsWith('--web=') || word === '--repo' || word.startsWith('--repo=')
        || (short(word) && /[wR]/.test(word)))
  }
  if (name === 'rg') {
    return !rest.some((word) => (word.startsWith('--') && word !== '--' && !RG_LONG.has(word.slice(2).split('=')[0]))
      || (short(word) && /[zL]/.test(word)))
  }
  return false
}

function decide(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.tool_name !== 'string') return false
  const tool = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null
  if (!tool) return false
  if (TOOLS.has(input.tool_name)) return true
  // Its read tools, in its folder: Read a file there, Grep and Glob there (their folder by default), LS a folder there.
  // Read opens what its person sent it too, and the Artifact tool reads the links they sent.
  if (input.tool_name === 'Read') return inside(tool.file_path) || attached(tool.file_path)
  if (input.tool_name === 'Artifact') return artifactAllowed(tool)
  if (input.tool_name === 'LS') return inside(tool.path)
  if (input.tool_name === 'Grep') return tool.path === undefined || inside(tool.path)
  if (input.tool_name === 'Glob') {
    return (tool.path === undefined || inside(tool.path)) && typeof tool.pattern === 'string' && !outward(tool.pattern)
  }
  return input.tool_name === 'Bash' && tool.run_in_background !== true && bashAllowed(tool.command)
}

let text = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { text += chunk })
process.stdin.on('end', () => {
  let input = null
  try { input = JSON.parse(text) } catch { /* refused below */ }
  const allow = decide(input)
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: allow ? 'A Buddy may read.' : MAY } }))
})
`

/** The list for one Buddy session, by its Swarm skill's key: in Harness's data folder, never in the Buddy's own folder,
 *  where a commit or a pull could put one. */
export function buddyReadsOf(key: string): BuddyReads {
  return { file: join(env.ADAPTER_DATA_DIR, 'buddy-reads', `${createHash('sha256').update(key).digest('hex')}.json`), drops: PASTE_DROPS_DIR }
}

/** A message holds at most ten files (superTabs/attachments.ts): ten messages' worth, and as many links. */
const MAX_FILES = 100
const MAX_LINKS = 50

/** A claude.ai Artifact link as the guard compares it (`artifactLink` in the guard above, the same rules), or null. */
function artifactLink(text: string): string | null {
  let url: URL
  try { url = new URL(text) } catch { return null }
  const path = /^\/((?:code\/)?artifact\/[A-Za-z0-9_-]{1,100})\/?$/.exec(url.pathname)
  if (!path || url.protocol !== 'https:' || !['claude.ai', 'preview.claude.ai'].includes(url.hostname) || url.port || url.username
    || url.password || url.search || url.hash) return null
  return `https://${url.hostname}/${path[1]}`
}

/** The claude.ai Artifact links in a message's text, each as the artifact's own link: a query or fragment the person's
 *  link carried is dropped, so the Buddy reads the artifact by the one link the guard lets it read. */
export function artifactLinks(text: string): string[] {
  const found = new Set<string>()
  for (const [candidate] of text.matchAll(/https:\/\/[^\s<>()[\]{}"'`]+/gi)) {
    let url: URL
    try { url = new URL(candidate.replace(/[.,;:!?]+$/, '')) } catch { continue }
    url.search = ''; url.hash = ''
    const link = artifactLink(url.href)
    if (link) found.add(link)
  }
  return [...found].slice(0, MAX_LINKS)
}

interface ListedFile { path: string; dev: string; ino: string; size: string; at: number }
interface ListedLink { url: string; at: number }
interface List { version: 1; files: ListedFile[]; links: ListedLink[] }

function heldList(file: string): List {
  try {
    const held = JSON.parse(readFileSync(file, 'utf8')) as { files?: unknown; links?: unknown }
    const entries = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : []
    return { version: 1,
      files: entries(held.files).filter((entry): entry is Record<string, unknown> & ListedFile => ['path', 'dev', 'ino', 'size']
        .every(field => typeof entry[field] === 'string') && Number.isFinite(entry.at)),
      links: entries(held.links).filter((entry): entry is Record<string, unknown> & ListedLink => typeof entry.url === 'string' && Number.isFinite(entry.at)) }
  } catch { return { version: 1, files: [], links: [] } }
}

/** Best-effort, as the downloads' own prune is (lib/pasteDropFiles.ts): the lists of Buddy sessions nothing has written to
 *  for a day, ended or quiet, hold nothing the guard would still allow. */
function sweep(dir: string, now: number): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue
      try { if (now - statSync(join(dir, name)).mtimeMs >= KEPT_MS) rmSync(join(dir, name), { force: true }) } catch { /* raced: ignore */ }
    }
  } catch { /* unreadable: nothing to sweep */ }
}

/**
 * Lists for one Buddy the files and Artifact links its person sent it in their own Buddy chat (superTabs/host.ts decides
 * that), before the message reaches it. Each file is listed by its path with its device, inode and size, and only as one
 * regular file in the downloads folder with no other name: what the guard checks again when the Buddy opens it. Entries
 * last a day. The host's poll loop is the only writer, and it writes synchronously, so two deliveries never interleave;
 * the guard reads a whole old list or a whole new one, never a part (a rename).
 */
export function allowBuddyReads(reads: BuddyReads, sent: { files: readonly string[]; links: readonly string[] }, now = Date.now()): void {
  const files = sent.files.flatMap((path): ListedFile[] => {
    if (dirname(path) !== reads.drops) return []
    try {
      const stat = lstatSync(path, { bigint: true })
      return stat.isFile() && stat.nlink === 1n ? [{ path, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), at: now }] : []
    } catch { return [] }
  })
  const links = sent.links.flatMap((url): ListedLink[] => artifactLink(url) === url ? [{ url, at: now }] : [])
  if (!files.length && !links.length) return
  const dir = dirname(reads.file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  sweep(dir, now)
  const held = heldList(reads.file)
  const fresh = <T extends { at: number }>(entries: T[]) => entries.filter(entry => now - entry.at < KEPT_MS)
  const list: List = { version: 1,
    files: [...fresh(held.files).filter(entry => !files.some(file => file.path === entry.path)), ...files].slice(-MAX_FILES),
    links: [...fresh(held.links).filter(entry => !links.some(link => link.url === entry.url)), ...links].slice(-MAX_LINKS) }
  const temporary = `${reads.file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(list)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, reads.file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** The hook's command. Exit 2 is Claude Code's blocking error: a guard that cannot run refuses the call, where any other
 *  failure would hand it to the permission rules, the person's own allow rules among them. */
export function buddyGuardCommand(node: string, script: string): string {
  return `${shellQuote(node)} ${shellQuote(script)} || exit 2`
}
