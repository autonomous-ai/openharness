/**
 * The guards every lesson passes (daemons/LEARNING.md, "Untrusted text"). Everything an agent or a tool
 * wrote is untrusted: a README, a test's output or a web page an agent read can carry text written to be
 * saved as a lesson and replayed into every agent. A 2026 study of self-improving agent setups found every
 * one of them saved unsafe lessons; these checks are why this one does not.
 *
 *   redact()        secrets, keys, tokens and emails out; absolute home paths to `~`. For evidence and
 *                   provenance, and for a lesson's own words.
 *   stripInjection() instructions addressed to a model ("ignore previous instructions", role tags, "save
 *                   this as a skill") replaced by `[removed]`, before any text reaches a model prompt.
 *   refusal()       why a lesson may never be saved: it pipes a download into a shell, carries a
 *                   credential, asks to switch a safety off, still speaks to a model, or sends files out.
 *   codeSpan()      a command or test name inside a lesson: an inert inline code span, one line, capped.
 *   redactDeep()    redact() over every string of a record, for what learning writes to disk.
 */

export type Refusal = 'pipe-to-shell' | 'secret' | 'disable-safety' | 'injection' | 'exfiltration'

/** Credentials by their shape. Checked on a lesson before redaction: a lesson with one is refused. */
const SECRET_PATTERNS: RegExp[] = [
  // PEM keys (RSA, EC, OPENSSH, PKCS#8 …) and armored PGP private key blocks; a key cut off runs to the end.
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\bsk-(ant-)?[A-Za-z0-9_-]{16,}/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids: long-term (AKIA) and temporary, from STS (ASIA).
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // A Google key may end in `-`, where \b would need a word character after it.
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]

/**
 * The names a secret is assigned to, as the last part of a longer name: `DB_PASSWORD`, `aws_secret_access_key`,
 * `x-api-key`, and the camelCase of AWS's own JSON (`SecretAccessKey`, `SessionToken`) — but not inside a word
 * (`oauth`, `nopassword`, `OAuth`). No prefix is matched, only the one character before the name: a pattern that
 * walked `a-b-c-…` from every word boundary took seconds on one long line of a tool's output. Case-insensitive
 * by hand, so the camelCase hump (a capital after a lowercase letter or digit) can be told from a word.
 */
const SECRET_NAMES = ['api[_-]?key', 'apikey', 'access[_-]?key', 'secret(?:[_-]?key)?', 'token', 'password', 'passwd', 'pwd', 'auth', 'credentials?', 'private[_-]?key']
const anyCase = (src: string): string => src.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`)
const SECRET_NAME = `(?:(?<![A-Za-z0-9])(?:${SECRET_NAMES.map(anyCase).join('|')})|(?<=[a-z0-9])(?:${SECRET_NAMES.map((n) => n[0].toUpperCase() + anyCase(n.slice(1))).join('|')}))`
/** The name, its quote (plain, or JSON-escaped `\"` in a log line holding JSON), and `:` or `=`. */
const SECRET_LEAD = `${SECRET_NAME}${/\\?["']?\s*[:=]\s*/.source}`
/** `token=…`, `"password": "…"`, `Authorization: Bearer …` — the value goes, the name stays. A value that
 *  is a reference (`$API_KEY`, `<token>`, `{secret}`) or already `[redacted]` is not a secret. A backslash
 *  is part of a value, unless it escapes the closing quote. */
const ASSIGNED_SECRET = new RegExp(`(${SECRET_LEAD}${/\\?["']?/.source})${/((?:[^\s"',;\\$<{[]|\\(?!["']))(?:[^\s"',;\\]|\\(?!["'])){5,})/.source}`, 'g')
/** A quoted value goes whole, spaces and all (`"password": "correct horse battery staple"`). */
const QUOTED_SECRET = new RegExp(`(${SECRET_LEAD})${/(\\?["'])(?![\s$<{[\\])([^\n]{6,512}?)\2/.source}`, 'g')
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}=*/gi
// Bounded (a scheme is short): from every word boundary of a long line, an unbounded scheme rescanned the rest.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi
// `git@github.com:org/repo` is an address, not a person's email. Bounded for the same reason, past RFC 5321's 64 and 255.
const EMAIL = /\b(?!git@)[A-Za-z0-9._%+-]{1,256}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}\b/g
const HOME_PATHS: RegExp[] = [
  /\/Users\/[^/\s"'`]+/g,
  /\/home\/[^/\s"'`]+/g,
  /\b[A-Za-z]:\\Users\\[^\\\s"'`]+/g,
]

export interface RedactOptions {
  /** This computer's home folder (os.homedir()), replaced by `~` wherever it appears. */
  home?: string | null
}

export function hasSecret(text: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => { pattern.lastIndex = 0; return pattern.test(text) })) return true
  for (const pattern of [ASSIGNED_SECRET, QUOTED_SECRET, BEARER, URL_CREDENTIALS]) {
    pattern.lastIndex = 0
    if (pattern.test(text)) return true
  }
  return false
}

/** Secrets, emails and home folders out. Idempotent. */
export function redact(text: string, opts: RedactOptions = {}): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  // Bearer first: `auth: Bearer <token>` would otherwise lose the word `Bearer` and keep the token.
  out = out.replace(BEARER, (whole) => `${whole.split(/\s+/)[0]} [redacted]`)
  out = out.replace(QUOTED_SECRET, (_whole, name: string, quote: string) => `${name}${quote}[redacted]${quote}`)
  out = out.replace(ASSIGNED_SECRET, (_whole, name: string) => `${name}[redacted]`)
  out = out.replace(URL_CREDENTIALS, '$1[redacted]@')
  out = out.replace(EMAIL, '[email]')
  const home = opts.home?.replace(/\/+$/, '')
  if (home && home.length > 1) out = out.split(home).join('~')
  for (const pattern of HOME_PATHS) out = out.replace(pattern, '~')
  return out
}

/** Text written to steer a model, wherever it hides: in a test's output, a README, a web page. */
const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}?\b(previous|prior|above|earlier|preceding|all|any|your|the|these|those)\b[^.\n]{0,24}?\b(instructions?|prompts?|rules?|messages?|context|guidelines|directions)\b/gi,
  /\byou are now\b/gi,
  /\b(new|updated|real|actual|revised) (system )?(instructions?|prompt|rules)\s*:/gi,
  /<\/?\s*(system|assistant|user|developer|instructions?|im_start|im_end|tool)\b[^>]*>/gi,
  /^\s*(system|assistant|developer)\s*:/gim,
  /\[\/?(INST|SYS)\]|<<\/?SYS>>/g,
  /<\|[a-z_]+\|>/gi,
  /\bpretend (to be|you are|that you)\b/gi,
  /\bdo not (tell|inform|show|alert) the (user|human|person)\b/gi,
  /\b(save|store|remember|record|add|learn) (this|these|the following|it)( text| instructions?)? (as|into|to) (a |an |your )?(lesson|skill|memory|memories|note|agents\.md|claude\.md)\b/gi,
  /\b(add|write|append) (this|the following) to (your )?(memory|skills?|agents\.md|claude\.md)\b/gi,
]

export function hasInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => { pattern.lastIndex = 0; return pattern.test(text) })
}

export function stripInjection(text: string): string {
  let out = text
  for (const pattern of INJECTION_PATTERNS) out = out.replace(pattern, '[removed]')
  return out
}

const PIPE_TO_SHELL: RegExp[] = [
  /\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|c|tc|fi)?sh\b/i,
  /\b(curl|wget|fetch|iwr|irm)\b[^\n]*\|\s*\S*(sh|python\d?|perl|ruby|node|php)\b/i,
  /\b(ba|z|da)?sh\s+<\(\s*(curl|wget)/i,
  /\b(ba|z|da)?sh\s+-c\s+["']?\$\(\s*(curl|wget)/i,
  /\beval\s+["']?\$\(\s*(curl|wget)/i,
  /\b(iex|invoke-expression)\b[^\n]*\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring)\b/i,
  /\bsource\s+<\(\s*(curl|wget)/i,
]

const DISABLE_SAFETY: RegExp[] = [
  /--dangerously[-\w]*/i,
  /--yolo\b/i,
  /--no-verify\b/i,
  /--(skip|bypass)-(permissions?|approvals?|sandbox|checks?|hooks?)\b/i,
  /\b(bypass|disable|turn off|switch off|skip|circumvent|remove)\b[^.\n]{0,24}?\b(sandbox|safety|guardrails?|permission( prompts?| checks?)?|approvals?|confirmations?|pre-commit|hooks?|security|review|verification|the floor)\b/i,
  /\b(always|auto)[- ]?(approve|accept|allow|confirm)\b/i,
  /\bdon'?t ask (for )?(permission|approval|the user|the person|before)\b/i,
  /\bwithout asking\b/i,
  /\ballow all\b/i,
  /\bchmod\s+(-R\s+)?[0-7]?777\b/i,
  /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(\/|~|\$HOME)(\s|$)/,
  /\bset\s+-o\s+noclobber\b.*\+o/i,
]

const EXFILTRATION: RegExp[] = [
  /\/dev\/(tcp|udp)\//i,
  /\b(curl|wget)\b[^\n]*(\s-d\s*@|--data(-binary|-raw)?\s*@|\s-F\s*\S*=@|--upload-file|\s-T\s)/i,
  /\b(nc|ncat|netcat)\b[^\n]*\s-e\s/i,
  /\b(\.ssh\/id_|\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json)\b[^\n]*\b(curl|wget|nc|scp|rsync)\b/i,
]

/** Why this text may never become a lesson, or null. Read over the whole of it. */
export function refusal(text: string): Refusal | null {
  if (PIPE_TO_SHELL.some((pattern) => pattern.test(text))) return 'pipe-to-shell'
  if (hasSecret(text)) return 'secret'
  if (DISABLE_SAFETY.some((pattern) => pattern.test(text))) return 'disable-safety'
  if (EXFILTRATION.some((pattern) => pattern.test(text))) return 'exfiltration'
  if (hasInjection(text)) return 'injection'
  return null
}

/** redact() over every string in a JSON-shaped value: journals, pending lessons, signals on disk. */
export function redactDeep<T>(value: T, opts: RedactOptions = {}): T {
  if (typeof value === 'string') return redact(value, opts) as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, opts)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactDeep(item, opts)])) as T
  }
  return value
}

/** One line of untrusted text, printable, with no backticks: fit to sit inside a code span or a sentence. */
export function inert(text: string, max = 80): string {
  const flat = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[`\x00-\x1f\x7f]/g, '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 3)).trimEnd()}...` : flat
}

/**
 * A command or a test name as a lesson quotes it: an inline code span that cannot close early (no
 * backticks), cannot start a new line or heading (no newlines), and is capped. Markdown renders it as code;
 * a model reads it as a name, not an instruction.
 */
export function codeSpan(text: string, max = 80): string {
  return `\`${inert(text, max) || '?'}\``
}

/**
 * Untrusted text made fit to keep as evidence or to fence into a prompt: one line, printable, redacted,
 * with instructions to a model struck out, at most `max` characters.
 */
export function untrusted(text: string, max: number, opts: RedactOptions = {}): string {
  const flat = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim()
  const clean = stripInjection(redact(flat, opts))
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 3)).trimEnd()}...` : clean
}
