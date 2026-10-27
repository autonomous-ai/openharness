import {
  HARNESS_ACCESS_PREFIX, HARNESS_HANDOFF_PREFIX, HARNESS_QR_POLL_PREFIX, HARNESS_QR_PREFIX, HARNESS_REFRESH_PREFIX,
  HARNESS_TEAM_ACCESS_PREFIX, HARNESS_TEAM_REFRESH_PREFIX,
} from '../lib/harnessTokenFormat.js'

/**
 * Credentials pasted into Swarm chat. In the live Swarm of 21–23 Oct 2026 someone pasted their Harness login access token
 * (a JWT) into a shared Lead chat, where every member and agent could read it. Everything a person or an agent posts passes
 * through here before it is stored: each credential becomes CREDENTIAL_MARKER and the rest of the text stays.
 *
 * Conservative on purpose. A known format must also look random; a generic `password=`, `token:` or `secret=` value must
 * be long, mix letters and digits, and look random. Commit ids, UUIDs, hashes in URLs, base64 images, code that names a
 * secret without holding one, and ordinary prose in any language pass unchanged.
 */
export type CredentialKind = 'private-key' | 'jwt' | 'harness' | 'github' | 'anthropic' | 'openai' | 'aws-key-id' | 'aws-secret'
  | 'slack' | 'google' | 'password'

/** What the sender is told was removed. */
export const CREDENTIAL_LABELS: Record<CredentialKind, string> = {
  'private-key': 'private key',
  jwt: 'JWT',
  harness: 'Harness sign-in token',
  github: 'GitHub token',
  anthropic: 'Anthropic API key',
  openai: 'OpenAI API key',
  'aws-key-id': 'AWS access key ID',
  'aws-secret': 'AWS secret access key',
  slack: 'Slack token',
  google: 'Google API key',
  password: 'password or secret',
}

export const CREDENTIAL_MARKER = '[credential removed]'

export interface FoundCredential { kind: CredentialKind; start: number; end: number }

/** Shannon entropy in bits per character: a placeholder (`xxxx`, `****`) is near 0, a random key above 3.5. */
function entropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) bits -= (count / value.length) * Math.log2(count / value.length)
  return bits
}
const hasLetterAndDigit = (value: string) => /[A-Za-z]/.test(value) && /\d/.test(value)
/** The random part of a known format: not a placeholder such as `ghp_xxxx…`. */
const random = (body: string) => entropy(body) >= 2.5
/** Random characters, not words: one run of 8 or more between separators mixes letters and digits (`Xk9mQ2vL…`, not
 *  `test-password-123`). `mixedCase` also takes 16 or more letters of both cases, as base64 without digits can be. */
function randomRun(value: string, mixedCase = false): boolean {
  return value.split(/[-_.:/+=~@]+/).some(run => (run.length >= 8 && hasLetterAndDigit(run))
    || (mixedCase && run.length >= 16 && /[a-z]/.test(run) && /[A-Z]/.test(run) && entropy(run) >= 3.5))
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A generic value people would call a password, token or secret: long, random characters. Never a UUID, a name that only
 *  refers to one (`process.env.API_TOKEN2`, `SECRET_KEY_V2`, `uuid::Uuid`), a path, a URL or a template. */
function secretValue(value: string, minimum = 12, mixedCase = false): boolean {
  if (value.length < minimum || !randomRun(value, mixedCase) || entropy(value) < 3 || UUID.test(value)) return false
  if (/^[A-Za-z_$][\w$-]*((\.|::)[A-Za-z_$][\w$-]*)+$/.test(value)) return false
  if (/^[A-Z][A-Z\d]*(_[A-Z\d]+)+$/.test(value)) return false
  return !/^(\/|~\/|\.\.?\/)|:\/\/|[${}<>]/.test(value)
}

function jwtHeader(segment: string): boolean {
  try {
    const header: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    return !!header && typeof header === 'object' && typeof (header as { alg?: unknown }).alg === 'string'
  } catch { return false }
}

interface Rule {
  kind: CredentialKind
  /** Global, with indices (`d`) so a capture group can name the secret. Each starts after a boundary, so a long run of
   *  letters is tried once, not at every position. */
  pattern: RegExp
  /** The capture group holding the secret; 0 is the whole match. A labelled value keeps its label. */
  group?: number
  /** Whether the secret is one, and how much of it to remove (a JWT at the end of a sentence keeps its full stop). */
  accept: (secret: string) => boolean | number
}

// A team session's tokens (lib/teamSession.ts) have their own prefixes; pasted, they are as live as any other sign-in.
const HARNESS_PREFIXES = [HARNESS_ACCESS_PREFIX, HARNESS_REFRESH_PREFIX, HARNESS_TEAM_ACCESS_PREFIX, HARNESS_TEAM_REFRESH_PREFIX,
  HARNESS_HANDOFF_PREFIX, HARNESS_QR_PREFIX, HARNESS_QR_POLL_PREFIX]
// Keys whose value is the secret: DB_PASSWORD, x-api-key, client_secret, access_token, "token": … Not `pwd` (a folder), and
// nothing public (.NET's publicKeyToken).
const KEY = String.raw`(?![\w.-]*public)[A-Za-z0-9_.-]*?(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?)`
const ASSIGN = String.raw`["']?[ \t]*(?:=>|:=|[:=])[ \t]*["'\x60]?`

/** Most specific first: a GitHub token inside `token=…` is a GitHub token. */
const RULES: Rule[] = [
  // A stateless GitHub App installation token, ghs_APPID_ and a JWT: before the JWT rule, which would miss it.
  { kind: 'github', pattern: /(?<![A-Za-z0-9_])ghs_\d+_[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/dg,
    accept: token => random(token.slice(token.lastIndexOf('.') + 1)) },
  { kind: 'jwt', pattern: /(?<![A-Za-z0-9_\-.+/])[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*){2,5}(?![A-Za-z0-9_\-+/=])/dg, accept: token => {
    // A full stop after the token ends the sentence; three segments are signed (JWS), five encrypted (JWE).
    const trimmed = token.endsWith('.') ? token.slice(0, -1) : token
    const segments = trimmed.split('.')
    return (segments.length === 3 || segments.length === 5) && segments[1]!.length > 0 && jwtHeader(segments[0]!) && trimmed.length
  } },
  { kind: 'harness', pattern: new RegExp(String.raw`(?<![A-Za-z0-9_-])(?:${HARNESS_PREFIXES.join('|')})[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`, 'dg'),
    accept: token => random(token.slice(4)) },
  { kind: 'github', pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{50,251})(?![A-Za-z0-9_])/dg,
    accept: token => random(token.slice(token.indexOf('_') + 1)) },
  { kind: 'anthropic', pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/dg, accept: token => random(token.slice(7)) && hasLetterAndDigit(token.slice(7)) },
  { kind: 'openai', pattern: /(?<![A-Za-z0-9_-])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/dg,
    accept: token => entropy(token) >= 3 && hasLetterAndDigit(token.slice(3)) },
  { kind: 'aws-key-id', pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/dg, accept: token => random(token.slice(4)) },
  { kind: 'aws-secret', group: 1, accept: value => entropy(value) >= 3.5,
    pattern: new RegExp(String.raw`(?<![A-Za-z0-9])(?:aws[_.\- ]?secret[_.\- ]?(?:access[_.\- ]?)?key|secret[_.\- ]?access[_.\- ]?key)${ASSIGN}([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])`, 'dgi') },
  { kind: 'slack', pattern: /(?<![A-Za-z0-9_-])xox[abprs]-\d{6,}-[A-Za-z0-9-]{8,}(?![A-Za-z0-9_-])/dg, accept: token => random(token) },
  // Base64 data cannot be next to it, so a long image never holds one by chance.
  { kind: 'google', pattern: /(?<![A-Za-z0-9_\-+/])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_\-+/])/dg, accept: token => random(token.slice(4)) },
  // Authorization: Bearer|Basic|Token …, which may be letters only (Basic is base64 of user:password).
  { kind: 'password', group: 1, accept: value => secretValue(value, 12, true),
    pattern: /(?<![A-Za-z0-9_-])Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token|Bot)\s+([A-Za-z0-9._~+/=-]{12,})/dgi },
  { kind: 'password', group: 1, accept: value => secretValue(value, 20), pattern: /(?<![A-Za-z0-9])Bearer\s+([A-Za-z0-9._~+/=-]{20,})/dg },
  // A password in a URL: postgres://app:…@db.
  { kind: 'password', group: 1, accept: value => randomRun(value) && entropy(value) >= 2.5 && !/[${}<>]/.test(value),
    pattern: /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,256}:([^\s/@]{8,256})@/dgi },
  { kind: 'password', group: 1, accept: value => secretValue(value.replace(/[.!?:]+$/, '')) && value.replace(/[.!?:]+$/, '').length,
    pattern: new RegExp(String.raw`(?<![A-Za-z0-9_.-])${KEY}${ASSIGN}([^\s"'\x60<>()[\]{}$%&,;\\]{12,})`, 'dgi') },
]

/** Private keys first, by hand: a block may be cut off before its END line, and then its base64 lines still go. */
function privateKeys(text: string): FoundCredential[] {
  const found: FoundCredential[] = []
  const begin = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----/g
  for (let match = begin.exec(text); match; match = begin.exec(text)) {
    const endLine = `-----END ${match[1]}-----`
    const end = text.indexOf(endLine, begin.lastIndex)
    let stop = end >= 0 ? end + endLine.length : begin.lastIndex
    if (end < 0) {
      // Cut off: the body on the same line (a JSON string with \n escapes), then the lines that follow while they are
      // base64 or `Proc-Type: …` headers.
      const inline = /(?:[A-Za-z0-9+/=]|\\[nr])*/y
      inline.lastIndex = stop
      inline.exec(text)
      stop = inline.lastIndex
      const lines = /\r?\n(?:[A-Za-z0-9+/]{8,}={0,2}|[A-Za-z0-9+/]{1,7}={1,2}|[A-Za-z-]+: [^\r\n]*)(?=\r?\n|$)/y
      lines.lastIndex = stop
      while (lines.exec(text)) stop = lines.lastIndex
    }
    // A key has a body; the BEGIN line alone, or an empty template, is only someone talking about the format.
    if (/[A-Za-z0-9+/]{16,}/.test(text.slice(begin.lastIndex, end >= 0 ? end : stop))) found.push({ kind: 'private-key', start: match.index, end: stop })
    begin.lastIndex = stop
  }
  return found
}

/** Every credential in the text, in order, none overlapping. */
export function findCredentials(text: string): FoundCredential[] {
  const found = privateKeys(text)
  // A data: URI's base64 is an image or a file, never a credential.
  const skipped = [...text.matchAll(/data:[\w/+.-]{1,100};base64,[A-Za-z0-9+/=]+/g)].map(m => ({ start: m.index, end: m.index + m[0].length }))
  const free = (start: number, end: number) => ![...found, ...skipped].some(f => start < f.end && f.start < end)
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const [start, end] = match.indices![rule.group ?? 0]!
      const verdict = rule.accept(text.slice(start, end))
      if (verdict === false || verdict === 0) continue
      const stop = typeof verdict === 'number' ? start + verdict : end
      if (free(start, stop)) found.push({ kind: rule.kind, start, end: stop })
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

/** The text with each credential replaced by CREDENTIAL_MARKER, and what was removed, one entry per credential. */
export function redactCredentials(text: string): { text: string; removed: CredentialKind[] } {
  const found = findCredentials(text)
  if (!found.length) return { text, removed: [] }
  let redacted = '', at = 0
  for (const { start, end } of found) {
    redacted += text.slice(at, start) + CREDENTIAL_MARKER
    at = end
  }
  return { text: redacted + text.slice(at), removed: found.map(f => f.kind) }
}

/** What the sender's command result says: which kinds went, and one line telling them to revoke or rotate it. */
export function credentialResult(removed: CredentialKind[]) {
  const kinds = [...new Set(removed)]
  const what = kinds.map(kind => CREDENTIAL_LABELS[kind]).join(', ')
  const notice = removed.length === 1
    ? `Removed a credential (${what}) before saving. Revoke or rotate it.`
    : `Removed ${removed.length} credentials (${what}) before saving. Revoke or rotate them.`
  return {
    credentialsRemoved: kinds.map(kind => ({ kind, label: CREDENTIAL_LABELS[kind], count: removed.filter(k => k === kind).length })),
    credentialNotice: notice,
  }
}
