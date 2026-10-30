import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync,
  writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { PASTE_DROPS_DIR } from './pasteDropFiles.js'

/** Where a Buddy's guard reads what its person sent it (the host's list for this Buddy), and where Harness downloads chat
 *  files to (lib/pasteDropFiles.ts). */
export interface BuddyReads { file: string; drops: string }
/** Wide mode's settings for a Buddy's guard (docs/specs/2026-10-30-buddy-read-access.md): its person's home, the places
 *  outside its folder that stay closed, and its person's approvals on this machine. */
export interface BuddyWide { home: string; denied: readonly string[]; approvals: string; repos: readonly string[] }

/** Places in a home that hold secrets or other people's data (the Lead's list, 10-30): ssh, cloud, GitHub, ArgoCD and
 *  Harness credentials; keychains; browser profiles and mail; shell and database histories, which keep typed secrets; and
 *  the Claude Code and Codex folders, where agents on this machine keep transcripts and pasted Swarm messages from chats
 *  the Buddy may not read (the Leads conversation, private chats, other projects). */
const CLOSED_IN_HOME = ['.ssh', '.aws', '.azure', '.config/gcloud', '.gnupg', '.kube', '.docker', '.config/gh', '.config/argocd',
  '.argocd', '.config/git/credentials', '.password-store', '.config/op', '.claude', '.claude.json', '.codex', '.local/share/claude',
  '.mozilla', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge', '.zsh_history',
  '.bash_history', '.zhistory', '.python_history', '.node_repl_history', '.mongodb', '.dbshell', '.psql_history', '.mysql_history',
  '.lesshst', '.viminfo', 'Library/Keychains', 'Library/Cookies', 'Library/Safari', 'Library/Messages', 'Library/Mail',
  'Library/Containers/com.apple.mail', 'Library/Group Containers', 'Library/Application Support/Google',
  'Library/Application Support/Firefox', 'Library/Application Support/BraveSoftware', 'Library/Application Support/Arc',
  'Library/Application Support/Microsoft Edge', 'Library/Application Support/com.operasoftware.Opera',
  'Library/Application Support/Claude']

/** Wide mode for one person's Buddy: [home] is theirs, [dataDir] Harness's data folder (its lists, approvals, downloads and
 *  agent records stay closed), [tmpDirs] where Claude Code keeps other sessions' tool output, [personKey] their id and
 *  membership, which keys their approvals, and [repos] the project's repositories (owner/name), the only ones gh api reads. */
export function buddyWideOf(input: { home: string; dataDir: string; tmpDirs: readonly string[]; personKey: string; repos: readonly string[] }): BuddyWide {
  return { home: input.home, repos: input.repos, denied: [...CLOSED_IN_HOME.map(path => join(input.home, path)), input.dataDir, ...input.tmpDirs],
    approvals: join(input.dataDir, 'buddy-approvals', `${createHash('sha256').update(input.personKey).digest('hex')}.json`) }
}

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
 * exact path the Buddy was handed, while it is still the one file Harness downloaded there and still holds the bytes it
 * held when listed (its SHA-256); the Artifact tool reads a listed link with its read action alone. The guard judges the
 * file when it answers and Claude Code opens it afterwards, as for its folder: bytes written into it in between are read.
 *
 * Plain JavaScript with node's own modules only, written into the Buddy's folder with that folder's real path and run by
 * Harness's node: the tests run this exact text (lib/buddyGuard.spec.ts, and Claude Code itself in
 * lib/buddyGuard.claude.spec.ts).
 */
export const buddyGuardSource = (root: string, reads: BuddyReads, wide: BuddyWide | null = null): string => String.raw`#!/usr/bin/env node
// A Buddy's guard, written by Harness (cli/src/lib/buddyGuard.ts). Do not edit: Harness writes it again at each launch.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// The Buddy's folder, as its real path: what it reads stays in it.
const ROOT = ${JSON.stringify(root)}
// What its person sent it in their Buddy chat, as the host lists it, and the folder Harness downloads chat files to.
const READS = ${JSON.stringify(reads.file)}
const DROPS = ${JSON.stringify(reads.drops)}
const KEPT_MS = ${KEPT_MS}
// Wide mode (docs/specs/2026-10-30-buddy-read-access.md): null keeps every read in the folder. Set only for a Buddy on its
// person's own machine, under their own account; it names their home and the places in it that stay closed.
const WIDE = ${JSON.stringify(wide)}
const TOOLS = new Set(['TodoWrite', 'ToolSearch'])
const READERS = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'grep', 'pwd'])
const WIDE_READERS = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'grep', 'rg'])
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
  'blame or status; gh issue view or list; gh pr view, list or diff; ls, cat, rg, head, tail, wc or grep; or harness super-tab. ' +
  'A file your person sent you in your chat opens with Read, by the path you were given; an Artifact link they sent, with the ' +
  'Artifact tool\'s read and that link.'

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

// The real path of [path] as the guard can best tell now: of the file, or of its nearest folder that exists with the rest
// added. The native call, so a case-insensitive volume gives the name as stored (.SSH reads as .ssh). Null when unreadable.
function realOf(path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return null
  let at = resolve(ROOT, path), rest = ''
  for (;;) {
    try { return join(realpathSync.native(at), rest) } catch { /* not there: its folder decides */ }
    if (dirname(at) === at) return null
    rest = rest ? join(basename(at), rest) : basename(at)
    at = dirname(at)
  }
}
// macOS volumes are case-insensitive by default: compare names as the volume does.
const fold = process.platform === 'darwin' || process.platform === 'win32' ? (path) => path.toLowerCase() : (path) => path
const under = (path, folder) => fold(path) === fold(folder) || fold(path).startsWith(fold(folder) + sep)
// Names that hold secrets wherever they are: .env files, keys and certificates, ssh keys, credential files, Harness's own
// folders and the person's prod database login (~/.harness-ro-prod-db, 10-28).
const SECRET_NAMES = [/^\.env/i, /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /^credentials/i,
  /^secrets?(\.|$)/i, /^\.harness/i, /ro-?prod|prod-?db/i, /^\.?(netrc|npmrc|pypirc|pgpass|htpasswd|git-credentials)$/i]
const secretName = (path) => path.split(sep).some((part) => SECRET_NAMES.some((name) => name.test(part)))
const realRoots = (paths) => paths.map((path) => realOf(path) ?? path)
const DENIED = WIDE ? realRoots(WIDE.denied) : []
const HOME = WIDE ? realOf(WIDE.home) : null
// Where people's homes are (/Users, /home): every one but the person's own stays closed. macOS's Shared folder is nobody's.
const HOMES = HOME ? dirname(HOME) : null
function otherHome(real) {
  if (!HOMES || !under(real, HOMES) || fold(real) === fold(HOMES) || under(real, HOME)) return false
  return fold(relative(HOMES, real).split(sep)[0]) !== 'shared'
}

// Whether [path], outside the folder, may be read in wide mode. 'any': Read (it may not exist yet); 'file': one regular
// file (content search: a folder could hold a .env or a key); 'dir': one folder's names (LS, ls); 'tree': a folder searched
// by name all the way down (Glob), so nothing closed may lie under it. The path as given and its real path are both
// judged: a link named innocently into ~/.ssh is refused, and so is one named .env.
function outsideAllowed(path, kind) {
  if (!WIDE || typeof path !== 'string') return false
  const real = realOf(path)
  if (!real || !HOME) return false
  if (secretName(real) || secretName(resolve(ROOT, path)) || otherHome(real) || DENIED.some((root) => under(real, root))) return false
  if (kind === 'tree' && (DENIED.some((root) => under(root, real)) || (HOMES && under(HOMES, real)))) return false
  if (kind === 'any') return true
  try {
    const stat = statSync(real)
    return kind === 'file' ? stat.isFile() : kind === 'dir' ? stat.isDirectory() : stat.isDirectory()
  } catch { return false }
}
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

// Whether [stat] is the one file the list names: a regular file with no other name, of the same device, inode and size.
const same = (stat, file) => stat.isFile() && stat.nlink === 1n && String(stat.dev) === file.dev && String(stat.ino) === file.ino
  && String(stat.size) === file.size

// Whether [path] is a file its person sent: listed by that exact path, in the downloads folder, still the one file Harness
// downloaded there (its device, inode and size), with no other name, and still holding the bytes it held when the host
// listed it. A link, a hard link (a second name for it) or another file put in its place would read something its person
// did not send; so would other bytes written into it, which keep its inode and can keep its size (security reviews 1 and
// 2 of #2248: 'OWNER' written over with 'OTHER' was read).
function attached(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || dirname(path) !== DROPS) return false
  const file = listed('files').find((entry) => entry.path === path)
  if (!file || typeof file.sha256 !== 'string') return false
  let fd
  try {
    if (!same(lstatSync(path, { bigint: true }), file) || realpathSync(path) !== join(realpathSync(DROPS), basename(path))) return false
    // Its bytes, read from the file just checked: opened without following a link, and checked again as opened.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd, { bigint: true })
    if (!same(opened, file)) return false
    // No more than its listed size: a file still being written to is not read on and on.
    const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024)
    let total = 0n
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      total += BigInt(read)
      if (total > opened.size) return false
      hash.update(chunk.subarray(0, read))
    }
    return hash.digest('hex') === file.sha256
  } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
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
  const out = rest.filter(outward)
  if (out.length) {
    // In wide mode the plain readers take a path outside the folder as a word of its own: a file (a folder for ls, and not
    // ls -R), never an option with a path glued on. Content search takes files only, as Grep does.
    if (!WIDE || !WIDE_READERS.has(name) || out.some((word) => word.startsWith('-') || !outsideAllowed(word, name === 'ls' ? 'dir' : 'file'))) return false
    if (name === 'ls' && rest.some((word) => longNames(word, ['recursive']) || (short(word) && word.includes('R')))) return false
  }
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

// Wide mode's commands (docs/specs/2026-10-30-buddy-read-access.md): reads of CI, ArgoCD, the cluster and Harness's own
// read-only recipes, each by an allowlist of subcommands and options, every option by its exact word (no prefixes, no
// short options run together). A command outside these never runs, approved or not; one inside them runs once its person
// has approved its exact words.

// [args] read by [spec]: its options, each a flag or one taking a value (as the next word, or after = for a long one,
// checked by spec.check when given), and the rest as positional words; null when any word is not the spec's.
function parse(args, spec) {
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    if (word.startsWith('-') && word.length > 1) {
      const [name, glued] = word.startsWith('--') && word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]
      if (glued === undefined && (spec.flags ?? []).includes(name)) continue
      if (!(spec.values ?? []).includes(name)) return null
      const value = glued ?? args[++i]
      if (value === undefined || (spec.check?.[name] && !spec.check[name](value))) return null
      continue
    }
    positional.push(word)
  }
  return spec.positional(positional) ? positional : null
}
const none = (p) => p.length === 0
const one = (test) => (p) => p.length === 1 && test(p[0])
// Repositories the project names, as owner/name.
const REPOS = new Set(WIDE?.repos ?? [])
const QUERY = /^\?[A-Za-z0-9_.,%-]+=[A-Za-z0-9_.,%-]*(&[A-Za-z0-9_.,%-]+=[A-Za-z0-9_.,%-]*)*$/
// A REST path of the project's own repositories, GET only, and none of its secrets, keys, tokens or hooks.
function repoPath(text) {
  const at = text.indexOf('?'), path = (at < 0 ? text : text.slice(0, at)).replace(/^\//, '').replace(/\/$/, '')
  if (at >= 0 && !QUERY.test(text.slice(at))) return false
  const parts = path.split('/')
  if (parts[0] !== 'repos' || parts.length < 3 || !REPOS.has(parts[1] + '/' + parts[2])) return false
  return parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== '..' && part !== '.') && !parts.some((part) => /secret|key|token|hook/i.test(part))
}
const appName = (text) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?)?$/.test(text)
// A cluster resource word (pods, deploy/x, pods,services) naming no secret.
const resource = (text) => /^[A-Za-z0-9.\/,-]+$/.test(text) && !/secret/i.test(text)
const WIDE_COMMANDS = {
  gh: {
    run: {
      list: { values: ['--limit', '-L', '--workflow', '-w', '--branch', '-b', '--status', '-s', '--event', '-e', '--commit', '-c', '--user',
        '-u', '--created', '--json', '--jq', '-q'], positional: none },
      view: { flags: ['--log', '--log-failed', '--verbose', '-v', '--exit-status'], values: ['--job', '-j', '--attempt', '-a', '--json', '--jq', '-q'],
        positional: (p) => p.length <= 1 && p.every((id) => /^[0-9]+$/.test(id)) },
    },
    api: { flags: ['--paginate', '--silent', '--slurp', '--include', '-i'], values: ['--jq', '-q', '--cache', '--method', '-X'],
      check: { '--method': (v) => v === 'GET', '-X': (v) => v === 'GET' }, positional: one(repoPath) },
  },
  argocd: {
    app: {
      list: { flags: ['--grpc-web'], values: ['-o', '--output', '-l', '--selector', '-p', '--project'], positional: none },
      get: { flags: ['--grpc-web', '--show-operation', '--show-params'], values: ['-o', '--output'], positional: one(appName) },
      resources: { flags: ['--grpc-web', '--orphaned'], values: ['-o', '--output'], positional: one(appName) },
      history: { flags: ['--grpc-web'], values: ['-o', '--output'], positional: one(appName) },
      logs: { flags: ['--grpc-web', '--previous', '-p', '--match-case'], values: ['--tail', '--since-seconds', '--until-time', '--container',
        '-c', '--kind', '--name', '--group', '--namespace', '--filter'], positional: one(appName) },
    },
    version: { flags: ['--client', '--short', '--grpc-web'], values: ['-o', '--output'], positional: none },
  },
  kubectl: {
    get: { flags: ['-A', '--all-namespaces', '--show-labels', '--no-headers'], values: ['-n', '--namespace', '--context', '-o', '--output',
      '-l', '--selector', '--field-selector', '--sort-by', '--request-timeout'], positional: (p) => p.length >= 1 && p.every(resource) },
    describe: { flags: ['-A', '--all-namespaces'], values: ['-n', '--namespace', '--context', '-l', '--selector', '--request-timeout'],
      positional: (p) => p.length >= 1 && p.every(resource) },
    top: { flags: ['-A', '--all-namespaces', '--containers', '--no-headers'], values: ['-n', '--namespace', '--context', '-l', '--selector',
      '--sort-by', '--request-timeout'], positional: (p) => p.length >= 1 && p.length <= 2 && ['pods', 'pod', 'po', 'nodes', 'node', 'no'].includes(p[0])
      && p.every(resource) },
    logs: { flags: ['--previous', '-p', '--timestamps', '--all-containers', '--prefix'], values: ['-n', '--namespace', '--context', '--since',
      '--since-time', '--tail', '-c', '--container', '--limit-bytes', '-l', '--selector', '--request-timeout'], positional: one(resource) },
    version: { flags: ['--client'], values: ['-o', '--output', '--context'], positional: none },
    'api-resources': { flags: ['--no-headers'], values: ['-o', '--output', '--context', '--namespaced'], positional: none },
    config: { positional: (p) => p.length === 1 && p[0] === 'current-context' },
  },
}
// Harness's own read-only measurements (lib/buddyRecipes.ts): their names alone, nothing added.
const RECIPES = new Set(['db-size', 'backend-cpu'])

// Whether [w] is one of wide mode's reads, whatever its approval.
function widerRead(w) {
  if (!WIDE) return false
  if (w[0] === 'harness') return w.length === 3 && w[1] === 'buddy-read' && RECIPES.has(w[2])
  let spec = WIDE_COMMANDS[w[0]], at = 1
  while (spec && !spec.positional && at < w.length) spec = Object.hasOwn(spec, w[at]) ? spec[w[at++]] : undefined
  return !!spec?.positional && parse(w.slice(at), spec) !== null
}

// An approval lasts 30 days from when its person sent it (docs/specs/2026-10-30-buddy-read-access.md, Design 1).
const APPROVAL_MS = 30 * 24 * 60 * 60 * 1000
// Whether its person approved exactly these words on this machine: the host's file, by their own "run:" line. A file it
// cannot read approves nothing.
function approved(w) {
  try {
    const entries = JSON.parse(readFileSync(WIDE.approvals, 'utf8')).entries, now = Date.now(), want = JSON.stringify(w)
    return Array.isArray(entries) && entries.some((entry) => entry && Array.isArray(entry.argv) && entry.argv.every((word) => typeof word === 'string')
      && Number.isFinite(entry.at) && now - entry.at < APPROVAL_MS && JSON.stringify(entry.argv) === want)
  } catch { return false }
}

const ASK = (command) => 'Not run before, so it was refused, and nobody will be asked here. Ask your person in your chat first: show ' +
  'them this exact command, why you want it and what it reads. They approve it by sending a line of their own: run: ' + command +
  ' . Do not run it again until they have.'
let reason = MAY

function decide(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.tool_name !== 'string') return false
  const tool = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null
  if (!tool) return false
  if (TOOLS.has(input.tool_name)) return true
  // Its read tools, in its folder: Read a file there, Grep and Glob there (their folder by default), LS a folder there.
  // Read opens what its person sent it too, and the Artifact tool reads the links they sent.
  if (input.tool_name === 'Read') return inside(tool.file_path) || attached(tool.file_path) || outsideAllowed(tool.file_path, 'any')
  if (input.tool_name === 'Artifact') return artifactAllowed(tool)
  if (input.tool_name === 'LS') return inside(tool.path) || outsideAllowed(tool.path, 'dir')
  if (input.tool_name === 'Grep') return tool.path === undefined || inside(tool.path) || outsideAllowed(tool.path, 'file')
  if (input.tool_name === 'Glob') {
    return (tool.path === undefined || inside(tool.path) || outsideAllowed(tool.path, 'tree')) && typeof tool.pattern === 'string'
      && !outward(tool.pattern)
  }
  if (input.tool_name !== 'Bash' || tool.run_in_background === true || typeof tool.command !== 'string') return false
  if (bashAllowed(tool.command)) return true
  const w = words(tool.command)
  if (!w || !widerRead(w)) return false
  if (approved(w)) return true
  reason = ASK(tool.command)
  return false
}

let text = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { text += chunk })
process.stdin.on('end', () => {
  let input = null
  try { input = JSON.parse(text) } catch { /* refused below */ }
  const allow = decide(input)
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: allow ? 'A Buddy may read.' : reason } }))
})
`

/** Where every Buddy session's list is kept: Harness's data folder, never a Buddy's own folder, where a commit or a pull
 *  could put one. */
const listsDir = () => join(env.ADAPTER_DATA_DIR, 'buddy-reads')

/** The list for one Buddy session, by its Swarm skill's key. */
export function buddyReadsOf(key: string): BuddyReads {
  return { file: join(listsDir(), `${createHash('sha256').update(key).digest('hex')}.json`), drops: PASTE_DROPS_DIR }
}

/** A message holds at most ten files (superTabs/attachments.ts): ten messages' worth, and as many links. */
const MAX_FILES = 100
const MAX_LINKS = 50
/** The backend's per-file limit (superTabs/attachments.ts MAX_ATTACHMENT_BYTES): no download is larger, so nothing larger
 *  is read whole to be listed. */
const MAX_BYTES = 10 * 1024 * 1024

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

interface ListedFile { path: string; dev: string; ino: string; size: string; sha256: string; at: number }
interface ListedLink { url: string; at: number }
/** `session`: the native session the host delivered these to, whose lists go when the Swarm ends it (`forgetBuddyReads`). */
interface List { version: 1; session: string; files: ListedFile[]; links: ListedLink[] }

/** What [file] holds for [session]: nothing another session listed under the same key, nor anything unreadable. */
function heldList(file: string, session: string): List {
  const none: List = { version: 1, session, files: [], links: [] }
  try {
    const held = JSON.parse(readFileSync(file, 'utf8')) as { session?: unknown; files?: unknown; links?: unknown }
    if (held.session !== session) return none
    const entries = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : []
    return { version: 1, session,
      files: entries(held.files).filter((entry): entry is Record<string, unknown> & ListedFile => ['path', 'dev', 'ino', 'size', 'sha256']
        .every(field => typeof entry[field] === 'string') && Number.isFinite(entry.at)),
      links: entries(held.links).filter((entry): entry is Record<string, unknown> & ListedLink => typeof entry.url === 'string' && Number.isFinite(entry.at)) }
  } catch { return none }
}

/** [path] as a listed file: one regular file with no other name, at most a download's size, by its device, inode, size and
 *  the SHA-256 of its bytes, all read from the one file opened (never through a link); null for anything else. */
function listedFile(path: string, at: number): ListedFile | null {
  let fd: number | undefined
  try {
    const named = lstatSync(path, { bigint: true })
    if (!named.isFile() || named.nlink !== 1n || named.size > MAX_BYTES) return null
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== named.dev || stat.ino !== named.ino || stat.size > MAX_BYTES) return null
    // No more than the size it opened at: the host's loop waits on this, and a file still being written to is not read on.
    const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024)
    let total = 0n
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      total += BigInt(read)
      if (total > stat.size) return null
      hash.update(chunk.subarray(0, read))
    }
    return { path, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), sha256: hash.digest('hex'), at }
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
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
 * Lists for one Buddy session the files and Artifact links its person sent it in their own Buddy chat (superTabs/host.ts
 * decides that), before the message reaches it. Each file is listed by its path with its device, inode, size and SHA-256,
 * and only as one regular file in the downloads folder with no other name: what the guard checks again when the Buddy
 * opens it. Entries last a day, or until the Swarm ends the session. The host's poll loop is the only writer, and it
 * writes synchronously, so two deliveries never interleave; the guard reads a whole old list or a whole new one, never a
 * part (a rename).
 */
export function allowBuddyReads(reads: BuddyReads, sent: { session: string; files: readonly string[]; links: readonly string[] }, now = Date.now()): void {
  const files = sent.files.flatMap(path => {
    const file = dirname(path) === reads.drops ? listedFile(path, now) : null
    return file ? [file] : []
  })
  const links = sent.links.flatMap((url): ListedLink[] => artifactLink(url) === url ? [{ url, at: now }] : [])
  if (!files.length && !links.length) return
  const dir = dirname(reads.file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  sweep(dir, now)
  const held = heldList(reads.file, sent.session)
  const fresh = <T extends { at: number }>(entries: T[]) => entries.filter(entry => now - entry.at < KEPT_MS)
  const list: List = { version: 1, session: sent.session,
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

/**
 * Deletes the lists of [session], once the Swarm has ended it: its Buddy removed, its person gone from the Swarm, or its
 * chat purged with its project (Lead, 10-30). Each list names its session, so a session no longer running here is found
 * too, and another session's list stays. One that names no session goes as well, since whose it is cannot be told: not
 * JSON, not a list, or a list from before lists named their session, which still allows its links. Deleting one of those
 * only ever refuses.
 *
 * Anything it cannot finish throws, so the host tries again and does not acknowledge the end meanwhile (re-checks of
 * #2248): a list it cannot read (re-check 1 of 116fa43a1: it was skipped, and allowed again once it could be read), which
 * it keeps, as it may be another session's and the failure may pass (too many open files, say); and one it cannot delete
 * (a folder it cannot write to), which it empties in place where it can, needing only the file, so the guard allows
 * nothing meanwhile, keeping its session so the next try finds it. A list that went between the folder's read and its own
 * counts too: the next try no longer finds it.
 */
export function forgetBuddyReads(session: string, dir = listsDir()): void {
  let names: string[]
  try { names = readdirSync(dir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let failed: unknown
  // Only a list's own name: a .tmp is a write not yet renamed, which no guard reads.
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    let text: string
    try { text = readFileSync(file, 'utf8') } catch (error) {
      failed ??= error
      continue
    }
    let named: unknown
    try { named = (JSON.parse(text) as { session?: unknown } | null)?.session } catch { /* not JSON: it names no session */ }
    if (typeof named === 'string' && named !== session) continue
    try { rmSync(file, { force: true }) } catch (error) {
      const empty: List = { version: 1, session, files: [], links: [] }
      try { writeFileSync(file, `${JSON.stringify(empty)}\n`) } catch { /* neither: the host's next try is all that is left */ }
      failed ??= error
    }
  }
  if (failed) throw failed
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** The hook's command. Exit 2 is Claude Code's blocking error: a guard that cannot run refuses the call, where any other
 *  failure would hand it to the permission rules, the person's own allow rules among them. */
export function buddyGuardCommand(node: string, script: string): string {
  return `${shellQuote(node)} ${shellQuote(script)} || exit 2`
}
