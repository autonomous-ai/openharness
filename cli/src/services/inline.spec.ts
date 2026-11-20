import { otherEngineRequests } from '../engines/others/otherEnginesProcess.js'
import { questionControlFor } from '../engines/questionControls.js'
import { modelControlFor } from '../engines/modelControls.js'
import { screenFor } from '../engines/screens.js'
import { submissionFor } from '../engines/submissions.js'
import { nativeControlFor } from '../engines/nativeControls.js'
import { backgroundJobFor } from '../engines/backgroundJobs.js'
import { providerMoveFor } from '../engines/providerMoves.js'
import { prepareResume } from '../engines/resumePreparation.js'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts } from '../core/api.js'
import { DEVICES_TOKEN_FILE, readDevicesRecord } from '../devices/listenerPipe.js'
import { newPipeNonce, PIPE_AUTH_HEADER, pipeAuthValue, readDaemonToken } from '../lib/windows/pipeAuth.js'
import { fakeCore } from '../testing/fakeCore.js'
import type { DevicesDeps } from './devices.js'
import type { DevicesListener, ListenerHandler } from './devicesListener.js'
import { engineTranscriptFor } from '../engines/transcripts.js'
import { databaseHistory } from '../engines/storeHistory.js'
import { liveFor } from '../engines/live.js'
import { runtimeFor } from '../engines/runtime.js'
import { startGateway } from '../gateway/start.js'
import { startAgentBrowser } from './agentBrowser.js'
import { startAgentCleanup } from './agentCleanup.js'
import { startMemory } from './memory.js'
import { startConnectors } from './connectors.js'
import { startDevices } from './devices.js'
import { startEngineProbe } from './engineProbe.js'
import { startHandoff } from './handoff.js'
import * as inline from './inline.js'
import { startModels } from './models.js'
import { startMessagesInCore } from './messages.js'
import { startMonitor } from './monitor.js'
import { startOrchestrator } from './orchestrator.js'
import { startOsDevice } from './osDevice.js'
import { startMachineAddons } from './machineAddons.js'
import { startProjects } from './projects.js'
import { startRecaps } from './recaps.js'
import { startRouter } from './router.js'
import { startCloud } from './cloud.js'
import { startSearch } from './search.js'
import { startShell } from './shell.js'
import { startSharedMachines } from './sharedMachines.js'
import { startSharing } from './sharing.js'
import { startStoreInCore } from './store.js'
import { startUsageInCore } from './usage.js'
import { startViewers } from './viewers.js'
import { startWifi } from './wifi.js'
import { startWindowNames } from './windowNames.js'
import { startGoals } from './goals.js'
import { startHachiInCore } from './hachi.js'
import { startHomeBridgeInCore } from './homeBridge.js'
import { startWorkspaces } from './workspaces.js'

// The devices' own start, stood in for: what the door gives it is what is checked. And the pipe a Windows start names,
// stood in for by a socket named harness-<32 hex> in the test's folder, as devicesListener.spec.ts does.
const door = vi.hoisted(() => ({ pipe: '' }))
vi.mock('./devices.js', async (importOriginal) => ({ ...await importOriginal<typeof import('./devices.js')>(), startDevices: vi.fn(() => ({})) }))
vi.mock('../lib/windows/pipeAuth.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../lib/windows/pipeAuth.js')>(), newPipePath: () => door.pipe }))

describe('the services the core runs in its own process only when they do not run in theirs', () => {
  it('are their own starts, unchanged: the same services either way, the devices aside', () => {
    const { startDevices: _devices, ...rest } = inline
    expect(rest).toEqual({ otherEngineRequests, engineTranscriptFor, databaseHistory, liveFor, runtimeFor, screenFor, submissionFor, nativeControlFor, backgroundJobFor, providerMoveFor, prepareResume, modelControlFor, questionControlFor, startAgentBrowser, startAgentCleanup, startCloud, startConnectors, startEngineProbe, startGoals, startHachiInCore, startHandoff, startHomeBridgeInCore, startGateway, startMemory, startModels, startMonitor, startOrchestrator, startOsDevice, startMachineAddons, startProjects, startRecaps, startRouter, startSearch, startSharedMachines, startSharing, startShell, startStoreInCore, startMessagesInCore, startUsageInCore, startViewers, startWifi, startWindowNames, startWorkspaces })
  })
})

describe('the devices in the core\'s process', () => {
  const dirs: string[] = []
  const listeners: DevicesListener[] = []
  const NO_AUTH = { status: 401, body: '{"error":"PIPE_AUTH_REQUIRED"}' }

  afterEach(async () => {
    for (const listener of listeners.splice(0)) await listener.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    vi.mocked(startDevices).mockClear()
  })

  /** The devices started through the door on [platform]: what their start was given, and what the door answered. */
  function startHere(platform: NodeJS.Platform) {
    // A socket's path has 96 bytes (lib/localSocket.ts): the test's longer temporary folder would not fit one.
    const dataDir = mkdtempSync('/tmp/hdi-')
    dirs.push(dataDir)
    door.pipe = join(dataDir, `harness-${randomBytes(16).toString('hex')}`)
    const deps: DevicesDeps = { logsDir: dataDir, cableDisabled: true }
    const answered = inline.startDevices(fakeCore({ dataDir }), emptyPorts(), deps, platform)
    const [core, , given] = vi.mocked(startDevices).mock.lastCall!
    expect(core.dataDir).toBe(dataDir)
    expect(answered).toBe(vi.mocked(startDevices).mock.results.at(-1)!.value)
    return { dataDir, deps, given }
  }

  /** Their listener opened with [handlers], as the devices open it, and every line it logged. */
  async function listen(given: DevicesDeps, handlers: Record<string, ListenerHandler>) {
    expect(given.listen).toBeInstanceOf(Function)
    const lines: string[] = []
    const listener = await given.listen!(handlers, (line) => lines.push(line))
    if (listener) listeners.push(listener)
    expect(listener).not.toBeNull()
    return lines
  }

  /** One message on the pipe with [auth] in x-harness-auth, or none. */
  function onPipe(body: string, auth: string | null): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const sent = request({ socketPath: door.pipe, agent: false, method: 'POST', path: '/', headers: auth === null ? {} : { [PIPE_AUTH_HEADER]: auth } }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      })
      sent.on('error', reject)
      sent.end(body)
    })
  }

  // Every service runs in the core's process on Windows (masterProcess.ts): without a listener there, no `harness device
  // notify`, editor or plugin would reach the dial.
  it('on Windows open a pipe of their own, as in their own process: the devices\' token and record in the data folder, and a message signed with that token is answered', async () => {
    const { dataDir, deps, given } = startHere('win32')
    expect(given).toMatchObject(deps)
    const lines = await listen(given, { ping: { maxBytes: 64, perSecond: 10, handle: () => ({ pong: true }) } })
    expect(lines).toEqual(['[devices] listener open'])
    expect(readDevicesRecord(dataDir)).toEqual({ pipe: door.pipe, pid: process.pid })
    const token = readDaemonToken(dataDir, DEVICES_TOKEN_FILE)!
    expect(await onPipe('{"type":"ping"}', pipeAuthValue(token, newPipeNonce(door.pipe)))).toEqual({ status: 200, body: '{"pong":true}' })
  })

  it('on Windows a message with no auth, or another token\'s, is 401 and its handler never runs', async () => {
    const { given } = startHere('win32')
    const handle = vi.fn(() => ({ pong: true }))
    await listen(given, { ping: { maxBytes: 64, perSecond: 10, handle } })
    expect(await onPipe('{"type":"ping"}', null)).toEqual(NO_AUTH)
    expect(await onPipe('{"type":"ping"}', pipeAuthValue(randomBytes(32), newPipeNonce(door.pipe)))).toEqual(NO_AUTH)
    expect(handle).not.toHaveBeenCalled()
  })

  it('elsewhere open no listener, as before: their start is given what the core gave the door', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { deps, given } = startHere(platform)
      expect(given).toBe(deps)
    }
  })
})
