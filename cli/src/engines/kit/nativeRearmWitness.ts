/** A launch-owned shell records its exact incarnation before exec. Reading that
 * record after a crash is evidence, never permission to execute the argv again. */
import { realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { AgentCreationReceipts, creationFingerprint, validCreationId, type NativeRelaunchRequest } from '../../lib/agentCreationReceipt.js'
import { inspectNativeControlFile } from '../../lib/nativeControlFile.js'
import { parseNativeArchiveEnvelope } from '../../lib/nativeArchive.js'
import { nativeTurnTarget, parseNativeTurnIntent, type NativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import { parseNativeAllocation } from '../../lib/nativeAllocation.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { prepareProcessImageHelper, type ProcessImageArtifact } from '../../lib/nativeProcessImageArtifact.js'
import { controlIdentity, probeNativeProcessControl, type NativeControlHelpers, type NativeControlSnapshot } from '../../lib/nativeProcessControlProbe.js'
import { secureStateDirectory } from '../../lib/secureState.js'
import { parseNativeLaunchAllocation, type NativeLaunchAllocation } from '../../lib/nativeLaunchAllocation.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'
import type { NativeLaunch } from '../nativeLaunch.js'
import { nativeHookScope, type NativeHookScope } from './nativeHookScope.js'
import { prepareNativeHookArtifact } from './nativeHookArtifact.js'
import { NativeEvidenceBudget, nativeUnavailable } from './nativeEvidence.js'
import { nativeLaunchProof, verifyNativeLaunchProof, type NativeLaunchProof } from './nativeLaunchGuard.js'
import { executableSnapshot, nativeVersionProbe } from './nativeVersion.js'
import { readNativeStopPane } from './nativePhysicalStop.js'

export interface NativeRearmWitnessRequest extends NativeRelaunchRequest {
  version: 1 | 2
  dataDir: string
  source: 'live' | 'saved'
  id: string
  control: NativeTurnIntent
  dependencies: NativeLaunchProof
  placement?: { binary: string; identity: string; owner: string }
}
export interface NativeRearmWitnessCommand {
  readonly token: string
  readonly node: string
  readonly artifact: string
  readonly request: string
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const held = (reason: string): never => nativeUnavailable(`the original native relaunch ${reason}`)
// On macOS /bin/sh is an exec shim: its running image is /bin/bash. Use
// the concrete binary so a configured shell cannot change the witness protocol.
const witnessShell = () => process.platform === 'darwin' ? '/bin/bash' : '/bin/sh'

export function inspectNativeRearmWitness(text: string): NativeRearmWitnessRequest {
  if (Buffer.byteLength(text) > 128 * 1024) return held('request exceeds its limit')
  let value: unknown
  try { value = JSON.parse(text) } catch { return held('request is incomplete') }
  if (!object(value) || value.version !== 1 && value.version !== 2
    || Object.keys(value).sort().join(',') !== (value.version === 2
      ? 'control,dataDir,dependencies,fingerprint,id,placement,request,source,version' : 'control,dataDir,dependencies,fingerprint,id,request,source,version')
    || typeof value.dataDir !== 'string' || !isAbsolute(value.dataDir) || value.dataDir.includes('\0') || value.dataDir.length > 4096
    || value.source !== 'live' && value.source !== 'saved' || !validCreationId(value.id) || !object(value.dependencies)
    || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !object(value.request)) return held('request is unsupported')
  if (value.version === 2 && (!object(value.placement) || Object.keys(value.placement).sort().join(',') !== 'binary,identity,owner'
    || typeof value.placement.binary !== 'string' || !isAbsolute(value.placement.binary) || value.placement.binary.length > 4096
    || /[\0\r\n]/.test(value.placement.binary) || typeof value.placement.identity !== 'string' || value.placement.identity.length > 16384
    || typeof value.placement.owner !== 'string' || !/^[a-f0-9]{16}$/.test(value.placement.owner))) return held('pane request is unsupported')
  const control = parseNativeTurnIntent(value.control), rearm = control?.rearm, request = value.request
  if (!rearm || rearm.revoked || rearm.replacement || Object.keys(request).sort().join(',') !== ['agentId', 'creationId', 'kind', 'launchToken', 'operation', 'target',
    ...(rearm.source === undefined ? [] : ['source']), ...(rearm.permissionMode === undefined ? [] : ['permissionMode']),
    ...(rearm.sourceProcess === undefined ? [] : ['sourceProcess'])].sort().join(',')
    || request.kind !== 'native-rearm' || request.creationId !== value.id
    || rearm.requestId !== value.id || request.agentId !== rearm.agentId || request.operation !== rearm.operation
    || request.launchToken !== rearm.launchToken || request.target !== rearm.target
    || request.source !== rearm.source || rearm.source !== undefined && value.source !== rearm.source
    || request.permissionMode !== rearm.permissionMode
    || creationFingerprint(request.sourceProcess ?? null) !== creationFingerprint(rearm.sourceProcess ?? null)
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(rearm.agentId)) return held('reservation is unavailable or revoked')
  return { ...value, control } as unknown as NativeRearmWitnessRequest
}

function readControl(input: NativeRearmWitnessRequest, budget: NativeEvidenceBudget) {
  const directory = input.source === 'live' ? input.dataDir : join(input.dataDir, 'stopped-agents')
  const file = join(directory, input.source === 'live' ? 'registry.json' : `${input.control.rearm!.agentId}.json`)
  const proof = inspectNativeControlFile(file, directory)
  const value: unknown = JSON.parse(proof.content!)
  const archive = input.source === 'saved' ? parseNativeArchiveEnvelope(value) : null
  const saved = archive?.session
  const savedOwner = archive && (archive.version === 1 || archive.version === 3 && archive.nativeReturn.phase === 'saved')
    && object(saved) && saved.active === false && !Object.hasOwn(saved, 'nativeArchive') && !Object.hasOwn(saved, 'nativeRetirement')
    && (archive.version !== 3 || archive.nativeReturn.link.agentId === saved.agentId)
  const rows = input.source === 'live' ? value : savedOwner ? [saved] : null
  if (!Array.isArray(rows) || rows.length > 4096) return held('saved control is incomplete')
  const selected = rows.filter(row => object(row) && row.agentId === input.control.rearm!.agentId)
  const allocation = selected[0]?.schemaVersion === 4 ? parseNativeAllocation(selected[0].nativeAllocation) : undefined
  if (selected.length !== 1 || !object(selected[0]) || ![3, 4].includes(selected[0].schemaVersion as number) || selected[0].engine !== 'cursor'
    || selected[0].schemaVersion === 4 && (!allocation || allocation.receipts.some(value => value.request.agentId !== selected[0].agentId))
    || selected[0].schemaVersion === 3 && Object.hasOwn(selected[0], 'nativeAllocation')
    || creationFingerprint(selected[0].nativeControl ?? null) !== creationFingerprint(input.control)
    || nativeTurnTarget(selected[0] as unknown as RegisteredSession) !== input.control.rearm!.target) return held('saved reservation changed')
  const verify = () => { proof.verify(); budget.step() }
  proof.confirm(verify)
  return { verify }
}

/** The one-shot writer has no daemon connection or configuration fallback. Its
 * numeric parent was captured by the new shell itself, before this child ran. */
export async function writeNativeRearmWitness(text: string, parent: string, deps: {
  selfPid: number
  artifact?: ProcessImageArtifact
  probe?: (pids: readonly number[], budget: NativeEvidenceBudget) => Promise<NativeControlSnapshot>
  scope?: typeof nativeHookScope
  pane?: typeof readNativeStopPane
  environment?: Pick<NodeJS.ProcessEnv, 'TMUX' | 'TMUX_PANE'>
}): Promise<boolean> {
  const input = inspectNativeRearmWitness(text), budget = new NativeEvidenceBudget(), self = deps.selfPid
  const environment = { ...(deps.environment ?? { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE }) }
  const caller = /^[1-9]\d*$/.test(parent) ? Number(parent) : 0
  if (!Number.isSafeInteger(caller) || caller <= 1 || caller > 0x7fffffff
    || !Number.isSafeInteger(self) || self <= 1 || self > 0x7fffffff || self === caller) return held('parent is unavailable')
  secureStateDirectory(input.dataDir, false)
  const control = readControl(input, budget), shell = realpathSync(witnessShell())
  verifyNativeLaunchProof(input.dependencies, budget)
  let prepared: Promise<{ path: string; key: string } | null> | undefined
  const helpers: NativeControlHelpers = {
    prepare: () => prepared ??= (async () => {
      if (!deps.artifact) return null
      const path = await prepareProcessImageHelper(deps.artifact, join(input.dataDir, 'native-hook-client-runtime'))
      return path ? { path, key: deps.artifact.sha256 } : null
    })(),
    invalidate: () => { prepared = undefined },
  }
  const probe = deps.probe ?? ((pids, budget) => probeNativeProcessControl(pids, 0, budget, false, helpers))
  const receiptDirectory = join(input.dataDir, 'agent-creations')
  const scope = deps.scope ?? nativeHookScope, originalScope = await scope(receiptDirectory, budget, helpers)
  let finalScope: NativeHookScope | undefined
  try {
    const { boot, namespace, storage } = originalScope
    const before = await probe([self, caller], budget), child = before.rows.get(self), owner = before.rows.get(caller)
    if (!child || child.parentPid !== caller) return held('writer is no longer the original shell’s child')
    if (!owner || owner.imagePath !== shell) return held(`original exec shell could not be proven (${owner?.imagePath ?? 'missing'})`)
    const childIdentity = controlIdentity(child), parentIdentity = controlIdentity(owner)
    let allocation: NativeLaunchAllocation | undefined, original: ReadonlyMap<number, string> | undefined
    let verifyPane: (() => Promise<void>) | undefined
    const placement = input.placement
    if (placement) {
      const match = typeof environment.TMUX === 'string' && environment.TMUX.length <= 4160
        ? /^(\/[^\0\r\n]+),([1-9]\d*),(?:0|[1-9]\d*)$/.exec(environment.TMUX) : null
      const serverPid = Number(match?.[2]), pane = environment.TMUX_PANE, rootPid = owner.parentPid
      if (!match || !pane || !/^%[0-9]{1,20}$/.test(pane) || !Number.isSafeInteger(serverPid) || serverPid <= 1 || serverPid > 0x7fffffff
        || rootPid <= 1 || new Set([self, caller, rootPid, serverPid]).size !== 4) return held('original pane candidates are unavailable')
      const verifyBinary = () => verifyNativeLaunchProof({ ready: true, command: placement.binary, identity: placement.identity, files: [] }, budget)
      verifyBinary()
      const observed = await probe([self, caller, rootPid, serverPid], budget), root = observed.rows.get(rootPid), server = observed.rows.get(serverPid)
      if (!root || !server || root.parentPid !== serverPid || server.imagePath !== realpathSync(placement.binary)
        || !observed.rows.get(self) || controlIdentity(observed.rows.get(self)!) !== childIdentity
        || !observed.rows.get(caller) || controlIdentity(observed.rows.get(caller)!) !== parentIdentity) return held('original pane ancestry changed')
      original = new Map([...observed.rows].map(([pid, row]) => [pid, controlIdentity(row)]))
      allocation = parseNativeLaunchAllocation({ pane, rootPid, token: input.request.launchToken, owner: placement.owner,
        root: { boot, namespace, pid: rootPid, birth: root.birth },
        endpoint: { binary: realpathSync(placement.binary), socket: match[1], server: { boot, namespace, pid: serverPid, birth: server.birth } },
      }, { boot, namespace, pid: caller }) ?? held('original pane association is invalid')
      const serverIdentity = controlIdentity(server), retained = allocation
      verifyPane = async () => {
        verifyBinary()
        const state = await (deps.pane ?? readNativeStopPane)(retained, budget, async () => {
          const fresh = (await probe([serverPid], budget)).rows.get(serverPid)
          if (!fresh || controlIdentity(fresh) !== serverIdentity) return held('original tmux server changed')
          verifyBinary(); return false
        })
        verifyBinary()
        if (state !== 'active') return held('original pane allocation is no longer active')
      }
      await verifyPane()
    }
    const receipt = new AgentCreationReceipts(receiptDirectory)
    const verifyScope = () => { originalScope.verify(receiptDirectory); finalScope?.verify(receiptDirectory); budget.step() }
    const permit = receipt.recordNativeRelaunchProcess(input.id, input, { boot, namespace, pid: caller, birth: owner.birth, ...(allocation ? { allocation } : {}) },
      { verify: () => { control.verify(); verifyScope() }, current: () => budget.step() })
    if (!permit) return false
    // Namespace and local-volume evidence belong to the original witness. A
    // different PID view must never turn ESRCH into permission to retire it.
    finalScope = await scope(receiptDirectory, budget, helpers)
    verifyScope()
    if (finalScope.boot !== boot || finalScope.namespace !== namespace || finalScope.storage !== storage) {
      return held('process or storage scope changed before handoff')
    }
    // Fsync can outlive pane ownership even if every PID remains the same.
    await verifyPane?.()
    // Durability and scope preparation may wait. This paired probe is the last
    // asynchronous observation: neither a reparented writer nor a new shell wins.
    const final = await probe(original ? [...original.keys()] : [self, caller], budget), currentChild = final.rows.get(self), currentOwner = final.rows.get(caller)
    if (!currentChild || !currentOwner || controlIdentity(currentChild) !== childIdentity || controlIdentity(currentOwner) !== parentIdentity) {
      return held('exec shell changed before handoff')
    }
    if (original && [...original].some(([pid, identity]) => !final.rows.get(pid) || controlIdentity(final.rows.get(pid)!) !== identity)) {
      return held('original pane ancestry changed before handoff')
    }
    if (placement) verifyNativeLaunchProof({ ready: true, command: placement.binary, identity: placement.identity, files: [] }, budget)
    verifyNativeLaunchProof(input.dependencies, budget)
    permit.verify(); verifyScope(); budget.step()
  } finally { try { finalScope?.close() } finally { originalScope.close() } }
  // Descriptor cleanup belongs to the same deadline as witness publication.
  budget.step()
  return true
}

/** Capture the shipped writer as a launch dependency before any pane is made.
 * An old notify script's no-op exit code cannot authorize this exec protocol. */
export function prepareNativeRearmWitness(launch: NativeLaunch, request: Omit<NativeRearmWitnessRequest, 'dependencies'>, node: string,
  moduleUrl = import.meta.url,
): NativeRearmWitnessCommand {
  const saved = structuredClone(request), input = inspectNativeRearmWitness(JSON.stringify({ ...saved, dependencies: nativeLaunchProof(launch) }))
  if (launch.token !== input.control.rearm!.launchToken || !isAbsolute(node) || !launch.current()) return held('prepared launch changed')
  const artifact = prepareNativeHookArtifact(moduleUrl, undefined, undefined, 'allocation')
  if (!launch.retain?.(artifact.proof)) return held('writer artifact could not be retained')
  const text = JSON.stringify({ ...saved, dependencies: nativeLaunchProof(launch) })
  inspectNativeRearmWitness(text)
  const command = Object.freeze({ token: launch.token, node, artifact: artifact.path, request: text })
  launch.rearmWitness = command
  return command
}

/** This shell is the foreground job, with its own job control left off. The
 * writer's status is tested before exec; no failure path can run a manual shell
 * under the witnessed PID. The outer wrapper still owns Stop and final exit. */
export function nativeRearmExecCommand(command: NativeRearmWitnessCommand, placement?: { binary: string | null; owner: string }): string {
  let request = command.request
  if (placement) {
    if (!placement.binary || !isAbsolute(placement.binary)) return held('original tmux binary is unavailable')
    const executable = executableSnapshot(nativeVersionProbe({ args: [], output: /^$/, timeoutMs: 1 }, () => placement.binary!))
    if (!executable) return held('original tmux binary could not be retained')
    request = JSON.stringify({ ...inspectNativeRearmWitness(request), version: 2,
      placement: { binary: executable.command, identity: executable.identity, owner: placement.owner } })
    inspectNativeRearmWitness(request)
  }
  const script = [
    'harness_rearm_interrupted=0',
    "trap 'harness_rearm_interrupted=1' INT QUIT HUP TERM",
    'harness_rearm_status=75',
    '"$1" "$2" --native-rearm-witness "$3" "$$" && harness_rearm_status=0',
    'trap - INT QUIT HUP TERM',
    'if [ "$harness_rearm_status" != 0 ] || [ "$harness_rearm_interrupted" != 0 ]; then',
    '  trap \'\' INT QUIT TSTP; trap - HUP TERM',
    "  printf '%s\\n' 'Waiting for the original native relaunch record to be confirmed.' >&2",
    '  while :; do sleep 3600; done',
    'fi',
    'shift 3',
    'exec "$@"',
  ].join('\n')
  // Privileged mode suppresses startup files and inherited shell functions;
  // the fixed script is the only code allowed to run before this exec.
  return [witnessShell(), '-p', '-c', script, 'harness-native-rearm', command.node, command.artifact, request].map(shellSingleQuote).join(' ')
    + ' "$harness_engine_bin" "$@"'
}
