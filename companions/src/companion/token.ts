/**
 * HARNESSD_PAIR_TOKEN: what makes a write tool the pair harness's own (daemons/BRAIN.md, "Control
 * interface"). A new token for every launch of the pair harness — a start or a resume — and none before
 * the first: until the pair harness has been launched, every write is refused.
 *
 * It lives in `ADAPTER_DATA_DIR/pair/token` (0600) because the pair harness's runtime is snapshotted at
 * creation (dsh/runtime.ts) and cannot be handed a fresh environment on resume: the harness is told the
 * file (`HARNESSD_PAIR_TOKEN_FILE`, and `--token-file` for its MCP server, since Codex passes a stdio
 * server only a short list of variables). A daemon that restarts reads it back, so a pair harness that
 * outlived it keeps working.
 *
 * What it keeps out: a shell, another harness's agent, a script — anything that runs `harness pair` or
 * speaks the loopback `pair` request without being the pair harness. Every process of the same user can
 * read the daemon's data directory, so it is a door, not a vault; the floor (pair/floor.ts) is enforced
 * whatever holds it.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const PAIR_TOKEN_ENV = 'HARNESSD_PAIR_TOKEN'
export const PAIR_TOKEN_FILE_ENV = 'HARNESSD_PAIR_TOKEN_FILE'

export class PairToken {
  private token: string | null = null

  constructor(readonly file: string) {
    try {
      const saved = readFileSync(file, 'utf8').trim()
      if (/^[a-f0-9]{64}$/.test(saved)) this.token = saved
    } catch { /* never launched */ }
  }

  /** A new token for a new launch of the pair harness. The old one stops working at once. */
  rotate(): string {
    const token = randomBytes(32).toString('hex')
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${token}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
    this.token = token
    return token
  }

  get launched(): boolean { return this.token !== null }

  matches(candidate: string): boolean {
    if (!this.token || typeof candidate !== 'string' || candidate.length !== this.token.length) return false
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token))
  }
}

/**
 * The token a CLI or MCP process presents: HARNESSD_PAIR_TOKEN, else the file HARNESSD_PAIR_TOKEN_FILE or
 * `--token-file` names. Read on every call, because a resume rotates it under a running MCP server.
 */
export function presentedToken(env: NodeJS.ProcessEnv, tokenFile?: string | null): string | null {
  const direct = env[PAIR_TOKEN_ENV]?.trim()
  if (direct) return direct
  const file = tokenFile || env[PAIR_TOKEN_FILE_ENV]
  if (!file || !existsSync(file)) return null
  try { return readFileSync(file, 'utf8').trim() || null } catch { return null }
}
