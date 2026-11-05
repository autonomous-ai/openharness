// The Buddy guard every Buddy launched before #2832 still runs (task #3159): buddyGuardSource of cli/src/lib/buddyGuard.ts at
// 9d46a8fc6^, the last main before it was removed, for a narrow Buddy (no wide mode, no own temp). A spec puts the folder, list
// and drops in place of /__BUDDY_ROOT__, /__BUDDY_READS__ and /__BUDDY_DROPS__. Remove with lib/buddyGuard.ts listSentToOldGuard.
// A Buddy's guard, written by Harness (cli/src/lib/buddyGuard.ts). Do not edit: Harness writes it again at each launch.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// The Buddy's folder, as its real path: what it reads stays in it.
const ROOT = "/__BUDDY_ROOT__"
// What its person sent it in their Buddy chat, as the host lists it, and the folder Harness downloads chat files to.
const READS = "/__BUDDY_READS__"
const DROPS = "/__BUDDY_DROPS__"
const KEPT_MS = 86400000
// Wide mode (docs/specs/2026-10-30-buddy-read-access.md): null keeps every read in the folder. Set only for a Buddy on its
// person's own machine, under their own account; it names their home and the places in it that stay closed.
const WIDE = null
// Its own private temporary folder beside a Team account (lib/agentTmp.ts), null elsewhere: read here, in either mode, and no other Buddy's.
const OWN_TEMP = null
// A person's one Buddy or plain session: its folder holds every project's code, and a proposal goes to any one project's PM.
const ONE_BUDDY = false
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

// Why the call was refused, as the Buddy is told it.
let reason = MAY

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

// Whether [path] is in its own temporary folder: named whole, by its real path, so a link or a ".." out is out, and with no
// secret's name below that folder. 'file': one regular file, for content search, which in a folder would read those names too.
function ownTemp(path, kind) {
  if (!OWN_TEMP || typeof path !== 'string' || !isAbsolute(path)) return false
  const real = realOf(path)
  if (!real || !under(real, OWN_TEMP)) return false
  if (secretName(relative(OWN_TEMP, real)) || secretName(relative(OWN_TEMP, resolve(path)))) return false
  if (kind !== 'file') return true
  try { return statSync(real).isFile() } catch { return false }
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
// main..HEAD has no ".." part. On Windows a drive names a place with or without a slash after it (D:x, ls C:), which the
// split at ":" would hide.
const OS_WINDOWS = process.platform === 'win32'
const outward = (word) => (OS_WINDOWS && /(^|=)[A-Za-z]:/.test(word)) || word.split(/[=:]/).some(escapes)
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
const SECRET_NAMES = [/^\.env/i, /\.env$/i, /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /^credentials/i,
  // A secrets folder, as the read-only prod database login is kept in ~/.secrets/ (harness buddy-read db-size, 10-30).
  /^\.?secrets?(\.|$)/i, /^\.harness/i,
  // Every Claude Code and Codex home or file by its name, wherever it is: a settings backup (~/.claude.json.bak-…), a home
  // beside the default one (~/.codex-work, final review of #2310).
  /^\.claude/i, /^\.codex/i, /ro-?prod|prod-?db/i, /^\.?(netrc|npmrc|pypirc|pgpass|htpasswd|git-credentials)$/i]
const secretName = (path) => path.split(sep).some((part) => SECRET_NAMES.some((name) => name.test(part)))
const realRoots = (paths) => paths.map((path) => realOf(path) ?? path)
// Other sessions' folders (WIDE.otherSessions) are closed as these are; its own folder is read as its folder, before any of this.
const DENIED = WIDE ? realRoots([...WIDE.denied, ...(WIDE.otherSessions ?? [])]) : []
// What may be read outside the folder at all: the person's home and the system folders named for it. Everything else is
// closed, the process and device folders and every temporary folder among it (security reviews 1 and 2 of #2310: on Linux
// /proc/<pid>/environ held the read-only DB URL while db-size ran; on macOS /private/var/folders held other processes'
// files).
const READABLE = WIDE ? realRoots(WIDE.readable) : []
// Whether the host granted wide mode to this session: it checked, at its person's last message, that they are the account
// signed in on this machine (superTabs/host.ts, security reviews 1 and 2 of #2310). Without it, the folder alone.
// A grant is for this launch, the account signed in here now, and an hour at most (delta reviews of #2310): one from before
// a relaunch, under another account, after a sign-out, or older is none.
const GRANT_MS = 60 * 60 * 1000
function granted() {
  if (!WIDE) return false
  try {
    const list = JSON.parse(readFileSync(READS, 'utf8')), grant = list.wide
    if (!grant || typeof grant !== 'object' || grant.session !== list.session || grant.launch !== WIDE.launch) return false
    const account = JSON.parse(readFileSync(WIDE.accountFile, 'utf8')).accountId, age = Date.now() - grant.at
    return typeof account === 'string' && account.length > 0 && grant.account === account && Number.isFinite(grant.at) && age > -60_000 && age < GRANT_MS
  } catch { return false }
}
const NOT_GRANTED = 'Reading beyond your folder opens once your owner writes to you in your chat, on their own computer signed in as ' +
  'them. It was refused, and nobody will be asked. Tell your owner in one line.'
const NEVER = ['/proc', '/sys', '/dev']
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
  if (!WIDE || typeof path !== 'string' || !granted()) return false
  const real = realOf(path)
  if (!real || !HOME) return false
  if (!READABLE.some((root) => under(real, root)) || NEVER.some((root) => under(real, root))) return false
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
  // The prompt goes to claude.ai with the read: no secret in it (security reviews 1 and 2 of #2310).
  const kind = tool.prompt === undefined ? null : leakIn([tool.prompt])
  if (kind) { reason = SECRET(kind); return false }
  const link = artifactLink(tool.url)
  return link !== null && listed('links').some((entry) => entry.url === link)
}

// Secrets by their shape (docs/specs/2026-10-30-buddy-read-access.md, section 4), each named by its kind: what a Buddy
// reads must never reach a chat, its owner's own included, as Harness stores chats and shows them on other devices.
const SECRETS = [
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an API key', /\bsk-[A-Za-z0-9_-]{20,}|\bnpm_[A-Za-z0-9]{36}/],
  ['an AWS key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['a JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a URL with a password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]+:[^\s\/@]+@/i],
  ['a password or token', /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?[^\s"',;]{20,}/i],
]
const secretIn = (text) => SECRETS.find(([, shape]) => shape.test(text))?.[0] ?? null
// The distinctive shapes alone, without word edges, for text run together: a token broken by spaces or newlines, or split
// across fields or files (security reviews 1 and 2 of #2310). The generic ones would find secrets in ordinary prose once
// its spaces are gone ("risk-assessment" holds "sk-assessment…").
const RUN_TOGETHER = SECRETS.filter(([kind]) => kind !== 'an API key' && kind !== 'a password or token')
  .map(([kind, shape]) => [kind, new RegExp(shape.source.replace(/\\b/g, ''), shape.flags)])
// The kind of secret in [fields], each as written, without its spaces, and all of them run together; null when none.
function leakIn(fields) {
  const texts = fields.filter((field) => typeof field === 'string')
  const kind = texts.map(secretIn).find(Boolean)
  if (kind) return kind
  // Spaces, and zero-width and other format characters (delta reviews of #2310), hide a token alike.
  const together = [...texts, texts.join('')].map((text) => text.replace(/[\s\p{Cf}]+/gu, ''))
  return RUN_TOGETHER.find(([, shape]) => together.some((text) => shape.test(text)))?.[0] ?? null
}
// Every string in a JSON value, as the CLI decodes it before sending: an escape such as g hides nothing.
function decoded(text) {
  let value
  try { value = JSON.parse(text) } catch { return [] }
  const out = []
  const walk = (node) => { if (typeof node === 'string') out.push(node); else if (node && typeof node === 'object') Object.values(node).forEach(walk) }
  walk(value)
  return out
}
const SECRET = (kind) => 'This holds what looks like ' + kind + ', so nothing was sent, and nobody will be asked. Take it out and ' +
  'send again: never pass on secrets, tokens, keys or connection strings.'
// A file to attach, in the folder (outward refused any other), read whole as text to be checked for secrets. A Buddy's files
// stay at 10 MB, the form upload's size: a chat file may be 256 MB now, but one past 10 MB would go out with only its
// start checked, so it is refused. One that is not there holds nothing, as sending it fails anyway; one there that cannot
// be read is refused.
const ATTACH_MAX_BYTES = 10 * 1024 * 1024
const TOO_LARGE = 'A Buddy attaches files of up to 10 MB, so nothing was sent, and nobody will be asked. Attach a smaller file.'
function fileText(path) {
  let fd
  try {
    fd = openSync(resolve(ROOT, path), constants.O_RDONLY)
    const buffer = Buffer.alloc(ATTACH_MAX_BYTES + 1), read = readSync(fd, buffer, 0, buffer.length, 0)
    if (read > ATTACH_MAX_BYTES) { reason = TOO_LARGE; return null }
    return buffer.subarray(0, read).toString('utf8')
  } catch (error) { return error?.code === 'ENOENT' ? '' : null } finally { if (fd !== undefined) closeSync(fd) }
}
// A wide Buddy's proposal, and a one Buddy's, carries a summary, never what a command printed or another project's code (security
// review of #2530): no code block and at most 10 lines.
function pastedOutput(json) {
  let proposal
  try { proposal = JSON.parse(json) } catch { return false }
  const text = [proposal?.goal, proposal?.scope].filter((part) => typeof part === 'string').join('\n')
  return text.includes('\x60\x60\x60') || text.split('\n').length > 10
}
const STDIN = (action) => (action === 'post' ? 'A Buddy passes its message as TEXT itself' : 'A Buddy passes its proposal\'s JSON itself') +
  ': - in its place reads it from stdin, where Harness cannot check it for secrets. Nothing was sent, and nobody will be asked. ' +
  'Send again with it in quotes where the - was: ' + (action === 'post' ? 'harness super-tab post GROUP \'your message\' OPERATION_ID'
    + ', or in double quotes when it holds an apostrophe: "it\'s done"' : 'harness super-tab propose OPERATION_ID \'{"conversationId":"...","goal":"..."}\'') + '.'
const SUMMARIZE ='A proposal carries your summary of what you read, never its output: no code block and at most 10 lines. Nothing ' +
  'was sent, and nobody will be asked. Summarize the numbers and findings in a few lines and send again.'

// harness super-tab [--tab ID] ACTION ...: only a Buddy's actions, an --attach only from its folder, and nothing it sends
// carrying a secret.
function superTabAllowed(rest) {
  let i = 0
  while (rest[i] === '--tab') i += 2
  if (i > rest.length || !SUPER_TAB.has(rest[i])) return false
  const after = rest.slice(i + 1)
  if (after.some((word, at) => (word === '--attach' && (after[at + 1] === undefined || outward(after[at + 1])))
    || ['--agent', '--port', '--machine'].includes(word))) return false
  if (rest[i] !== 'post' && rest[i] !== 'propose') return true
  // A post's TEXT or a proposal's JSON that is exactly - is read from stdin (superTabs/command.ts, post since #2355), where
  // this guard sees only the dash and cannot check what is sent for secrets. A Buddy cannot feed stdin today (no pipes,
  // redirects or heredocs above), but the secret check must not rest on that. Any other text, -- or "- P1" among them, is
  // the message itself and is checked as it is.
  if (after[1] === '-') { reason = STDIN(rest[i]); return false }
  const attached = after.flatMap((word, at) => after[at - 1] === '--attach' ? [fileText(word)] : [])
  if (attached.includes(null)) return false
  // Its words one by one, and what it says run together: the post's text or the proposal's decoded fields, with its files.
  const content = rest[i] === 'post' ? [after[1]] : after[1] !== undefined ? decoded(after[1]) : []
  const kind = after.map(secretIn).find(Boolean) ?? leakIn([...content, ...attached])
  if (kind) { reason = SECRET(kind); return false }
  if ((WIDE || ONE_BUDDY) && rest[i] === 'propose' && after[1] !== undefined && pastedOutput(after[1])) { reason = SUMMARIZE; return false }
  return true
}

// harness tell|reply NAME [--json] -- WORDS (#2626): its owner's words for one of their own harnesses on this Mac, only while
// its owner is with it here (granted(): they wrote to it in their own chat, signed in on this machine, within the hour). No
// --machine, --port or any other option: this Mac only. The machine checks the rest from its own records (messages/tell.ts
// relayRefusal): whose harness it is, and the person's agents-tell-agents switch. Nothing comes back to read.
const AWAY = 'You pass words to your owner\'s harnesses only while they are with you: once they write to you in your chat, on ' +
  'this Mac signed in as them, for an hour. It was refused, and nobody will be asked. Tell your owner in one line.'
function relayAllowed(rest) {
  const dash = rest.indexOf('--')
  if (dash < 1) return false
  const before = rest.slice(0, dash), text = rest.slice(dash + 1)
  const names = before.filter((word) => word !== '--json')
  if (names.length !== 1 || before.length > 2 || !/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(names[0])) return false
  if (!text.join(' ').trim()) return false
  if (!granted()) { reason = AWAY; return false }
  const kind = text.map(secretIn).find(Boolean) ?? leakIn(text)
  if (kind) { reason = SECRET(kind); return false }
  return true
}

function bashAllowed(command) {
  if (typeof command !== 'string') return false
  const w = words(command)
  if (!w || w.length === 0) return false
  const [name, sub, verb] = w
  const rest = w.slice(1)
  if (name === 'harness') return sub === 'super-tab' ? superTabAllowed(w.slice(2)) : (sub === 'tell' || sub === 'reply') && relayAllowed(w.slice(2))
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
// A resource word naming a ConfigMap, whose values a dump would print (security reviews 1 and 2 of #2310).
const configMap = (text) => /configmap/i.test(text) || text.split(',').some((part) => /^cm(\.|\/|$)/i.test(part))
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
      // One resource of an app as the cluster holds it (Juno's pods, restarts and HPA read, 10-30): never a Secret.
      'get-resource': { flags: ['--grpc-web'], values: ['--kind', '--group', '--namespace', '--resource-name', '-o', '--output'],
        check: { '--kind': (v) => !/secret|configmap/i.test(v), '--resource-name': (v) => !/secret/i.test(v) }, positional: one(appName) },
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
// Harness's own read-only measurements (lib/buddyRecipes.ts): their names alone, nothing added. API CPU has none: it is
// Juno's ArgoCD logs read, run as it is (Lead, 10-30).
const RECIPES = new Set(['db-size'])

// Whether [w] is one of wide mode's reads, whatever its approval.
function widerRead(w) {
  if (!WIDE) return false
  if (w[0] === 'harness') return w.length === 3 && w[1] === 'buddy-read' && RECIPES.has(w[2])
  let spec = WIDE_COMMANDS[w[0]], at = 1
  while (spec && !spec.positional && at < w.length) spec = Object.hasOwn(spec, w[at]) ? spec[w[at++]] : undefined
  const positional = spec?.positional ? parse(w.slice(at), spec) : null
  if (!positional) return false
  // A ConfigMap is listed by name only: never described or printed whole.
  if (w[0] === 'kubectl' && positional.some(configMap)) {
    if (w[1] !== 'get') return false
    // kubectl takes the last -o or --output it is given, so every one is read.
    const formats = w.flatMap((word, at) => word === '-o' || word === '--output' ? [w[at + 1]] : word.startsWith('--output=') ? [word.slice(9)] : [])
    return formats.every((format) => format === 'name' || format === 'wide')
  }
  return true
}

// An approval lasts 30 days from when its person sent it (docs/specs/2026-10-30-buddy-read-access.md, Design 1).
const APPROVAL_MS = 30 * 24 * 60 * 60 * 1000
// Whether its person approved exactly these words on this machine, by their own "run:" line: the file the host pointed this
// session's list at once it had checked who sent them (superTabs/host.ts), and only in Harness's approvals folder. No
// pointer, a file elsewhere or one it cannot read approves nothing.
function approved(w) {
  try {
    const at = JSON.parse(readFileSync(READS, 'utf8')).approvals
    if (typeof at !== 'string' || !isAbsolute(at) || resolve(at) !== at || dirname(at) !== WIDE.approvalsDir) return false
    const entries = JSON.parse(readFileSync(at, 'utf8')).entries, now = Date.now(), want = JSON.stringify(w)
    return Array.isArray(entries) && entries.some((entry) => entry && Array.isArray(entry.argv) && entry.argv.every((word) => typeof word === 'string')
      && Number.isFinite(entry.at) && now - entry.at < APPROVAL_MS && JSON.stringify(entry.argv) === want)
  } catch { return false }
}

const ASK = (command) => 'Not run before, so it was refused, and nobody will be asked here. Ask your person in your chat first: show ' +
  'them this exact command, why you want it and what it reads. They approve it by sending a line of their own: run: ' + command +
  ' . Do not run it again until they have.'
function decide(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.tool_name !== 'string') return false
  const tool = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null
  if (!tool) return false
  if (TOOLS.has(input.tool_name)) return true
  // Its read tools, in its folder: Read a file there, Grep and Glob there (their folder by default), LS a folder there.
  // Read opens what its person sent it too, and the Artifact tool reads the links they sent.
  if (input.tool_name === 'Read') return inside(tool.file_path) || attached(tool.file_path) || ownTemp(tool.file_path, 'any') || outsideAllowed(tool.file_path, 'any')
  if (input.tool_name === 'Artifact') return artifactAllowed(tool)
  if (input.tool_name === 'LS') return inside(tool.path) || ownTemp(tool.path, 'any') || outsideAllowed(tool.path, 'dir')
  if (input.tool_name === 'Grep') return tool.path === undefined || inside(tool.path) || ownTemp(tool.path, 'file') || outsideAllowed(tool.path, 'file')
  if (input.tool_name === 'Glob') {
    return (tool.path === undefined || inside(tool.path) || ownTemp(tool.path, 'any') || outsideAllowed(tool.path, 'tree')) && typeof tool.pattern === 'string'
      && !outward(tool.pattern)
  }
  // A command never leaves Claude Code's sandbox (wide mode's, lib/buddyGuard.ts buddySandboxSettings): the guard's allow
  // must not stand in for the person's approval Claude Code would otherwise ask for.
  if (input.tool_name !== 'Bash' || tool.run_in_background === true || tool.dangerouslyDisableSandbox !== undefined
    || typeof tool.command !== 'string') return false
  if (bashAllowed(tool.command)) return true
  const w = words(tool.command)
  if (!w || !widerRead(w)) return false
  if (!granted()) { reason = NOT_GRANTED; return false }
  if (approved(w)) return true
  reason = ASK(tool.command)
  return false
}

let text = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { text += chunk })
process.stdin.on('end', () => {
  // The host's question (lib/buddyGuard.ts recordBuddyApprovals): is this command one of wide mode's reads? Asked with an
  // argument Claude Code never passes, so the host judges a person's "run:" line with these very rules.
  if (process.argv[2] === '--classify') {
    let commands = []
    try { commands = JSON.parse(text) } catch { /* judged as none */ }
    const verdicts = (Array.isArray(commands) ? commands : []).map((command) => {
      const w = typeof command === 'string' ? words(command.trim()) : null
      return { read: !!(w && w.length && widerRead(w)), argv: w }
    })
    process.stdout.write(JSON.stringify({ wide: !!WIDE, verdicts }))
    return
  }
  let input = null
  try { input = JSON.parse(text) } catch { /* refused below */ }
  const allow = decide(input)
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: allow ? 'A Buddy may read.' : reason } }))
})
