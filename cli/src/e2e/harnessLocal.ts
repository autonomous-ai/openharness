/**
 * harnessLocal — what the e2e reads from THIS machine's harness install, the same places the
 * daemon itself uses (`env.ts`), so nothing has to be passed in: the daemon's port, this
 * computer's id, and the tmux pane an agent runs in (the registry row's runtime).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { env } from '../config/env.js'
import { localCredentialHeaders } from '../lib/localCredential.js'
import type { GridOverride } from './gridSwitchDriver.js'

const execFileP = promisify(execFile)

export function daemonPort(): number {
  return Number(process.env.HARNESS_PORT ?? env.PORT)
}

/**
 * What every request to the daemon's loopback TCP API carries: its local credential, read from its data
 * folder as every other client of it reads it (lib/localCredential.ts). Without it the daemon answers
 * `/api/status` with who it is but not its machine, and refuses `/api/local-ws` (401), since guest machine
 * sharing (bc7f56ff9, CLI 0.4.21): grid-dev's run stopped there on 2026-10-19.
 */
export function localHeaders(): Record<string, string> {
  return localCredentialHeaders(env.ADAPTER_DATA_DIR)
}

export function daemonUrl(): string {
  return `ws://127.0.0.1:${daemonPort()}/api/local-ws`
}

/**
 * The machine id the RUNNING daemon answers `machine_select` for — read from its own
 * `/api/status`, the same way `harness status` does. Not `computer-id`: that is this box's
 * identity, while the daemon binds a backend-issued machine id, and a `machine_select` for any
 * other id is relayed as a remote machine (`NO_PEER_LINK`).
 */
export async function machineId(): Promise<string> {
  if (process.env.HARNESS_MACHINE_ID) return process.env.HARNESS_MACHINE_ID
  const res = await fetch(`http://127.0.0.1:${daemonPort()}/api/status`, { headers: localHeaders(), signal: AbortSignal.timeout(3_000) })
  if (!res.ok) throw new Error(`daemon /api/status answered ${res.status} — is \`harness\` running on port ${daemonPort()}?`)
  const status = (await res.json()) as { machineId?: unknown; credentialRequired?: unknown }
  // The public answer: this process could not show the credential (another OS user, or another data folder).
  if (status.credentialRequired === true) {
    throw new Error(`daemon on port ${daemonPort()} wants its local credential, and this process could not read it from ${env.ADAPTER_DATA_DIR}/hook-credential — run as the daemon's user, with its ADAPTER_DATA_DIR`)
  }
  if (typeof status.machineId !== 'string' || !status.machineId) throw new Error('daemon /api/status has no machineId')
  return status.machineId
}

interface RegistryRow {
  agentId?: string
  tmuxPane?: string
  runtimes?: Array<{ backend?: string; paneId?: string }>
}

/** The `%N` tmux pane of `agentId`, from the registry the daemon writes; null until it is registered. */
export function paneOf(agentId: string): string | null {
  let rows: RegistryRow[]
  try {
    const raw = JSON.parse(readFileSync(join(env.ADAPTER_DATA_DIR, 'registry.json'), 'utf8')) as unknown
    rows = Array.isArray(raw) ? (raw as RegistryRow[]) : []
  } catch {
    return null
  }
  const row = rows.find((r) => r.agentId === agentId)
  if (!row) return null
  const pane = row.runtimes?.find((r) => r.backend === 'tmux')?.paneId ?? row.tmuxPane
  return pane && /^%\d+$/.test(pane) ? pane : null
}

/** Poll `paneOf` until the daemon has registered the agent's pane (a fresh agent takes a moment). */
export async function waitForPane(agentId: string, timeoutMs = 30_000): Promise<string | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const pane = paneOf(agentId)
    if (pane) return pane
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

/**
 * A grid the daemon is NOT signed into — a local relay checkout under test — described the way
 * `agent_retarget` takes it. Resolved from another `GRID_HOME` through the public `grid` CLI:
 * `grid info --env <name>` gives the relay URL + key, `grid ls` the network id. Set
 * E2E_GRID_HOME (+ E2E_GRID_CONTROL_PLANE_URL) and E2E_GRID_NAME to use it.
 */
export async function gridOverrideFromEnv(): Promise<{ override: GridOverride; name: string } | null> {
  const home = process.env.E2E_GRID_HOME
  const name = process.env.E2E_GRID_NAME
  if (!home || !name) return null
  const env = { ...process.env, GRID_HOME: home, ...(process.env.E2E_GRID_CONTROL_PLANE_URL ? { GRID_CONTROL_PLANE_URL: process.env.E2E_GRID_CONTROL_PLANE_URL } : {}) }
  const { stdout: envOut } = await execFileP('grid', ['info', '--env', name], { env, timeout: 30_000 })
  const baseUrl = /OPENAI_BASE_URL='([^']+)'/.exec(envOut)?.[1]
  const apiKey = /OPENAI_API_KEY='([^']+)'/.exec(envOut)?.[1]
  const { stdout: ls } = await execFileP('grid', ['ls'], { env, timeout: 30_000 })
  const networkId = ls.split('\n').map((l) => l.trim().split(/\s+/)).find((cols) => cols[0] === name)?.[1]
  if (!baseUrl || !apiKey || !networkId) throw new Error(`could not resolve grid ${name} from GRID_HOME=${home}`)
  return { override: { networkId, networkName: name, baseUrl, apiKey }, name }
}
