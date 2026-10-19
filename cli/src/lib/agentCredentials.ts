/**
 * Where the agent CLIs on this computer keep their sign-ins, read the way they write them: Claude
 * Code's OAuth tokens in the macOS login Keychain (`Claude Code-credentials`) or, where there is no
 * Keychain, in `~/.claude/.credentials.json`; Codex's in `~/.codex/auth.json`.
 *
 * Shared by the two readers that need the OWNER's sign-in without asking it of the CLI that owns
 * it: the usage reading (`accountUsage.ts`, which only reads) and the guest subscription relay
 * (`ownerSubscriptions.ts`, which also refreshes and writes back). Nothing here logs or returns a
 * token anywhere but to its caller.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The Keychain service Claude Code stores its OAuth sign-in under (no `CLAUDE_CONFIG_DIR`). */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** Everything reading reaches outside for, so a spec never touches a real home or Keychain. */
export interface CredentialReadDeps {
  home?: string
  platform?: NodeJS.Platform
  /** The Keychain item's secret (its JSON), or null. Production asks `security`. */
  readKeychain?: () => Promise<string | null>
}

export type ClaudeCredentialSource = 'keychain' | 'file'

export const claudeCredentialsPath = (home: string): string => join(home, '.claude', '.credentials.json')
export const claudeProfilePath = (home: string): string => join(home, '.claude.json')
export const codexAuthPath = (home: string): string => join(home, '.codex', 'auth.json')

/**
 * Claude Code's stored sign-in as it was written, and where it came from — the Keychain first and
 * the file second, as the desktop reads its own: macOS keeps the token in the login Keychain and
 * Linux in a file, and a Keychain that will not answer is a state, not the end of the road.
 */
export async function readClaudeStored(
  deps: CredentialReadDeps = {},
): Promise<{ raw: string; source: ClaudeCredentialSource } | null> {
  const keychain = await readClaudeKeychain(deps)
  if (keychain !== null) return { raw: keychain, source: 'keychain' }
  const file = await readText(claudeCredentialsPath(deps.home ?? homedir()))
  return file !== null ? { raw: file, source: 'file' } : null
}

/** The macOS Keychain item Claude Code writes — `security` rather than a native module, for one
 *  read of one generic password. */
export async function readClaudeKeychain(deps: CredentialReadDeps = {}): Promise<string | null> {
  if (deps.readKeychain) return deps.readKeychain()
  if ((deps.platform ?? process.platform) !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { timeout: 5_000 },
    )
    const out = stdout.trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** A half-written credentials file is not news — the CLI that owns it is mid-refresh, and the next
 *  read moments later finds it whole. */
export function parseJson(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A JWT's claims, unverified: for display and expiry hints only, never an authentication decision. */
export function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  return asRecord(parseJson(Buffer.from(parts[1]!, 'base64url').toString('utf8')))
}
