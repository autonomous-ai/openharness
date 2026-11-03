#!/usr/bin/env node
/**
 * The Store packages against the installed daemon on Windows, for the Windows workflow's install job (task #2161, audit W1
 * follow-up). Each package reaches the daemon over its named pipe with the pipe auth (lib/localDaemon.mjs `daemonPipe`), and never
 * its TCP port; store/tools/windows-pipe.test.mjs proves the port hears nothing, and this proves the real daemon answers them.
 * Nothing signs in: a signed-out daemon serves under this computer's id (cli/scripts/windows-ci/opencode.mjs).
 *
 *   node store/tools/windows-ci/store-pipe.mjs     prints one line per call; exits 1 when any did not reach the daemon.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closeBridges, listAgents as monitorAgents } from '../../agents/harness-monitor/lib/bridge.mjs'
import { closeBridges as closeMemories, listAgents as memoriesAgents } from '../../agents/memories/lib/bridge.mjs'
import { closeSessions, daemonStatus, listHarnesses } from '../../agents/machine-monitor/lib/daemon.mjs'
import { harnessExecute } from '../../agents/autonomous-grid/lib/harness.mjs'
import { daemonPipe, daemonSocketPath } from '../local-daemon.mjs'
import { localCredentialHeaders } from '../local-credential.mjs'

const say = (line) => console.log(`[store-pipe] ${line}`)
let failed = false
const check = (name, ok, detail) => { say(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); if (!ok) failed = true }

check('platform', process.platform === 'win32', process.platform)
check('no socket, no credential', daemonSocketPath(18473) === null && Object.keys(localCredentialHeaders()).length === 0,
  'nothing here is ever sent to the port')
check('the daemon\'s pipe', daemonPipe(18473) !== null, daemonPipe(18473)?.path ?? 'no live pipe in the record')

const machineId = readFileSync(join(homedir(), '.harness', 'computer-id'), 'utf8').trim()
const status = await daemonStatus()
check('machine monitor, REST /api/status', status.ok === true, status.ok ? `machine ${status.status?.machineId ?? '?'}` : status.error)

const roster = await listHarnesses(machineId, { timeoutMs: 20_000 })
check('machine monitor, bridge', roster.ok === true, roster.ok ? `${roster.harnesses?.length ?? 0} harnesses` : roster.error)

for (const [name, list] of [['harness monitor, bridge', monitorAgents], ['memories, bridge', memoriesAgents]]) {
  try {
    const agents = await list(machineId, { timeoutMs: 20_000 })
    check(name, Array.isArray(agents), `${agents?.length ?? 0} agents`)
  } catch (error) {
    check(name, false, error.message)
  }
}

// Grid is not installed here, so the command itself is refused; its answer is still the daemon's, over the pipe. Only a bridge
// that never opened, or a machine that never answered, fails this.
const UNREACHED = /Could not open|connection failed|could not connect|did not connect|unavailable or needs linking/i
const grid = await harnessExecute({ machineId }, ['ls'], { timeoutMs: 20_000 })
check('autonomous grid, bridge', grid.ok || !UNREACHED.test(grid.error ?? ''), grid.ok ? 'ran' : `the daemon answered: ${grid.error}`)

closeBridges(); closeMemories(); closeSessions()
process.exit(failed ? 1 : 0)
