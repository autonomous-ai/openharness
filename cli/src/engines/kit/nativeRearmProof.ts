/** Recovery proves the original exec, never chooses a descendant or retries it. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { AgentCreationReceipts, CreationConfirmationFence, NativeRelaunchRequest } from '../../lib/agentCreationReceipt.js'
import { creationFingerprint, validCreationId } from '../../lib/agentCreationReceipt.js'
import { enginePathOverride } from '../../lib/engineBin.js'
import { NATIVE_LAUNCH_MARKER } from '../../lib/nativePaneHold.js'
import { controlIdentity, nativeProcessControl, type NativeControlRow } from '../../lib/nativeProcessControl.js'
import { nativeTurnTarget, parseNativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import { readProcessEvidence } from '../../lib/processEvidence.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { argvTokens, type ProcessRow } from '../../lib/tmux.js'
import { NativeEvidenceBudget, nativeText, nativeUnavailable } from './nativeEvidence.js'
import { kernelBootId } from './nativeHookBoot.js'
import type { NativeHookOwnerProof } from './nativeHookOwner.js'
import type { ProcessIdentity } from '../../lib/terminalTypes.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'

export interface NativeRearmPane { readonly rootPid: number; readonly command: string }
export interface NativeRearmReplacementProof extends NativeHookOwnerProof {
  readonly processIdentity: Readonly<ProcessIdentity>
  readonly pane: string
  readonly source: Readonly<{ target: string; controlFingerprint: string; requestFingerprint: string }>
  /** Only beside the Registry's exact published-image proof. Its own rename
   * intentionally invalidates the former source leaf, never the receipt. */
  verifyExecution(): void
  /** Only beside the Registry image and the creation publisher's retained
   * confirmation. That publisher intentionally replaces prior absence. */
  verifyConfirmation(): void
  /** Disk-free original owner, shutdown and native-observation deadline. */
  current(): void
}
export interface NativeRearmObservation extends Promise<NativeRearmReplacementProof> {
  /** Actual native I/O lifetime, independent of the bounded reply. Never rejects. */
  readonly settled: Promise<void>
}
const held = (reason: string): never => nativeUnavailable(`the original native replacement ${reason}`)

/** Display tokens are only candidates. On an interpreter, only the digest of
 * the kernel-observed direct entry can authorize its role. Discovery's broader
 * matcher also recognizes pre-exec launchers and cannot confirm a relaunch. */
export function nativeRearmEngine(engine: NativeControlRow, observed: ProcessRow, declared?: string): boolean {
  const base = basename(engine.imagePath)
  const cursorPath = (path: string) => path.startsWith('/') && (basename(path) === 'cursor-agent'
    || /\/cursor-agent\/versions\/[^/]+\/index\.js$/.test(path) || path === declared)
  if (/^(?:node|nodejs|bun)$/.test(base)) {
    if (!engine.directEntryDigest) return false
    const candidates = [...(engine.argv ?? observed.nativeArgv ?? argvTokens(observed.args)).slice(0, 8),
      engine.imagePath.replace(/\/(?:node|nodejs|bun)$/, '/index.js'), ...(declared ? [declared] : [])]
    // ps does not quote spaces reliably. These bounded complete-path candidates
    // are never argv authority: only an exact native digest match admits one.
    if (!engine.argv && !observed.nativeArgv) {
      const display = observed.args.slice(0, 8192), suffix = /\/cursor-agent\/versions\/[^/\r\n]{1,256}\/index\.js/g
      let match: RegExpExecArray | null, attempts = 0
      while ((match = suffix.exec(display)) && attempts < 128) {
        const end = match.index + match[0].length
        for (let start = display.indexOf('/'); start >= 0 && start <= match.index && attempts++ < 128;
          start = display.indexOf('/', start + 1)) {
          if (end - start < 4096) candidates.push(display.slice(start, end))
        }
      }
    }
    return candidates.some(path => cursorPath(path)
      && createHash('sha256').update(path).digest('hex') === engine.directEntryDigest)
  }
  if (/^(?:sh|bash|dash|zsh|ksh|fish|tcsh|csh|env|sleep|ori|deno|python(?:\d+(?:\.\d+)*)?|perl|ruby)$/.test(base)) return false
  return cursorPath(engine.imagePath)
}

/** The marker is the original argv prefix, not a substring of a prompt/script
 * or the pane's current environment. Keep the complete bounded command identity. */
export function inspectNativeRearmPane(output: string, pane: string, token: string, owner?: string): NativeRearmPane {
  if (!/^%\d+$/.test(pane) || !validCreationId(token) || Buffer.byteLength(output) > 512 * 1024 || output.includes('\0')) {
    return held('pane evidence is invalid')
  }
  const match = /^(%\d+)\n([1-9]\d*)\n0\n([\s\S]+)\n$/.exec(output)
  const rootPid = Number(match?.[2]), command = match?.[3]
  const wrapper = owner && /^[a-f0-9]{16}$/.test(owner) ? `/usr/bin/env HARNESS_DAEMON=${owner} ` : ''
  const launch = wrapper && command?.startsWith(wrapper) ? command.slice(wrapper.length) : command
  if (!match || match[1] !== pane || !Number.isSafeInteger(rootPid) || rootPid <= 1 || rootPid > 0x7fffffff
    || !launch!.startsWith(`/usr/bin/env ${NATIVE_LAUNCH_MARKER}=${token} `)) return held('pane no longer owns the reserved launch')
  return Object.freeze({ rootPid, command: createHash('sha256').update(command!).digest('hex') })
}

export async function readNativeRearmPane(pane: string, token: string, budget: NativeEvidenceBudget, owner?: string): Promise<NativeRearmPane> {
  if (!/^%\d+$/.test(pane) || !validCreationId(token)) return held('pane identity is invalid')
  const timeout = budget.probe()
  const output = await new Promise<Buffer>((resolve, reject) => {
    execFile('tmux', ['display-message', '-p', '-t', pane, '#{pane_id}\n#{pane_pid}\n#{pane_dead}\n#{pane_start_command}'],
      { encoding: 'buffer', maxBuffer: 512 * 1024, timeout, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if (error || stderr.length) { reject(Error('The native relaunch pane query did not complete.')); return }
        resolve(stdout)
      })
  })
  budget.step(output.length)
  return inspectNativeRearmPane(nativeText(output), pane, token, owner)
}

/** A complete numeric listing supplies one candidate. Neither its PID nor the
 * pane's existence authorizes launch or proves the reserved engine. */
export function inspectNativeRearmCandidate(output: string, parentPid: number): string {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || parentPid > 0x7fffffff
    || Buffer.byteLength(output) > 512 * 1024 || !output.endsWith('\n')) return held('pane candidates are incomplete')
  const lines = output.slice(0, -1).split('\n'), seen = new Set<string>()
  if (lines.length > 8192) return held('pane candidates exceed their limit')
  let candidate: string | undefined
  for (const line of lines) {
    const match = /^(%\d{1,20})\t([1-9]\d*)$/.exec(line), pid = Number(match?.[2])
    if (!match || !Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff || seen.has(match[1])) {
      return held('pane candidates are invalid')
    }
    seen.add(match[1])
    if (pid === parentPid) {
      if (candidate) return held('pane candidates are ambiguous')
      candidate = match[1]
    }
  }
  return candidate ?? held('pane candidate is unavailable')
}

export async function findNativeRearmPane(parentPid: number, budget: NativeEvidenceBudget): Promise<string> {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || parentPid > 0x7fffffff) return held('pane parent is invalid')
  const timeout = budget.probe()
  const output = await new Promise<Buffer>((resolve, reject) => {
    execFile('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}'],
      { encoding: 'buffer', maxBuffer: 512 * 1024, timeout, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if (error || stderr.length) { reject(Error('The original native pane lookup did not complete.')); return }
        resolve(stdout)
      })
  })
  budget.step(output.length)
  return inspectNativeRearmCandidate(nativeText(output), parentPid)
}

export function createNativeRearmProof({ receipts, owner, pane = readNativeRearmPane, findPane = findNativeRearmPane, boot = kernelBootId,
  inspect = readProcessEvidence, probe = nativeProcessControl,
}: {
  receipts: Pick<AgentCreationReceipts, 'readNativeRelaunchProcess'>
  owner: string
  pane?: typeof readNativeRearmPane
  findPane?: typeof findNativeRearmPane
  boot?: typeof kernelBootId
  inspect?: typeof readProcessEvidence
  probe?: typeof nativeProcessControl
}) {
  let running = 0
  const result = async (input: RegisteredSession, request: NativeRelaunchRequest, fence: CreationConfirmationFence,
    settle: () => void, recoveryPane?: string | null): Promise<NativeRearmReplacementProof> => {
    try {
      if (running >= 8) return held('evidence slots are occupied')
      if (!/^[a-f0-9]{16}$/.test(owner)) return held('daemon pane owner is invalid')
      const row = structuredClone(input), expected = structuredClone(request), budget = new NativeEvidenceBudget()
      const { verify: verifyFence, current: currentFence } = fence
      let expired = false, timer: ReturnType<typeof setTimeout>
      const timeout = budget.remaining()
      running++
      const observe = async () => {
        try {
          const control = parseNativeTurnIntent(row.nativeControl), rearm = control?.rearm, intent = expected.request
          const recovering = recoveryPane !== undefined, discovering = recoveryPane === null
          let selectedPane = recoveryPane ?? row.tmuxPane
          if (row.engine !== 'cursor' || !row.sessionId || !rearm || rearm.revoked
            || !discovering && !/^%\d+$/.test(selectedPane ?? '')
            || discovering && (rearm.source !== 'saved' || rearm.operation !== 'resume' || row.active
              || row.nativeArchive || row.nativeRetirement || rearm.replacement)
            || (recovering ? !rearm.source || nativeTurnTarget(row) !== rearm.target
              || rearm.source === 'live' && selectedPane !== row.tmuxPane : !row.active || !row.processIdentity)
            || (!recovering || rearm.source === 'live') && (row.runtimes.length !== 1 || row.runtimes[0].backend !== 'tmux'
              || row.runtimes[0].paneId !== row.tmuxPane || row.primaryRuntimeKey !== terminalRouteKey(row.runtimes[0]))
            || rearm.agentId !== row.agentId || intent.kind !== 'native-rearm' || intent.creationId !== rearm.requestId
            || intent.agentId !== rearm.agentId || intent.operation !== rearm.operation || intent.target !== rearm.target
            || intent.source !== rearm.source || intent.permissionMode !== rearm.permissionMode
            || Object.hasOwn(intent, 'sourceProcess') !== Object.hasOwn(rearm, 'sourceProcess')
            || creationFingerprint(intent.sourceProcess ?? null) !== creationFingerprint(rearm.sourceProcess ?? null)
            || intent.launchToken !== rearm.launchToken) return held('reservation or current binding is unavailable')
          const declared = enginePathOverride('cursor')
          const current = () => {
            if (expired) return held('evidence deadline expired')
            budget.step(); currentFence(); budget.step()
            if (enginePathOverride('cursor') !== declared) return held('engine declaration changed')
          }
          verifyFence(); current()
          const receipt = receipts.readNativeRelaunchProcess(rearm.requestId, expected), witness = receipt.process
          if (!recovering && row.processIdentity!.pid !== witness.pid) return held('process differs from the recorded exec')
          const bootId = await boot(budget)
          if (bootId !== witness.boot) return held('kernel boot changed')
          current()
          let originalPair: { root: string; engine: string; entry: string | undefined } | undefined
          if (discovering) {
            const first = (await probe([witness.pid], 0, budget, false)).rows.get(witness.pid)
            current()
            if (!first || first.birth !== witness.birth || first.parentPid <= 1 || first.parentPid === witness.pid) {
              return held('witness parent is unavailable')
            }
            const pair = await probe([first.parentPid, witness.pid], 0, budget, false)
            current()
            const root = pair.rows.get(first.parentPid), engine = pair.rows.get(witness.pid)
            if (!root || !engine || controlIdentity(engine) !== controlIdentity(first) || engine.directEntryDigest !== first.directEntryDigest) {
              return held('witness parent changed before pane lookup')
            }
            originalPair = { root: controlIdentity(root), engine: controlIdentity(engine), entry: engine.directEntryDigest }
            selectedPane = await findPane(root.pid, budget)
            current()
          }
          const placement = await pane(selectedPane!, rearm.launchToken, budget, owner)
          current()
          const before = await probe([placement.rootPid, witness.pid], 0, budget, false)
          current()
          const root = before.rows.get(placement.rootPid), engine = before.rows.get(witness.pid)
          if (!root || !engine || engine.pid === root.pid || engine.parentPid !== root.pid || engine.birth !== witness.birth) {
            return held('engine is not the recorded pane child')
          }
          if (originalPair && (controlIdentity(root) !== originalPair.root || controlIdentity(engine) !== originalPair.engine
            || engine.directEntryDigest !== originalPair.entry)) return held('original witness parent changed during pane lookup')
          const rootIdentity = controlIdentity(root), evidence = controlIdentity(engine)
          const observed = (await inspect(witness.pid, budget, undefined, recovering ? undefined : row.processIdentity!)).parent
          current()
          if (!observed || observed.pid !== witness.pid || observed.nativeBirth !== witness.birth || observed.controlIdentity !== evidence
            || !nativeRearmEngine(engine, observed, declared)) return held('current Cursor image could not be proven')
          const key = `${bootId}\u0000cursor\u0000${witness.pid}\u0000${witness.birth}`
          if (rearm.replacement && (rearm.replacement.processKey !== key || rearm.replacement.sessionId !== row.sessionId)) {
            return held('confirmed replacement changed')
          }
          const placed = await pane(selectedPane!, rearm.launchToken, budget, owner)
          current()
          if (placed.rootPid !== placement.rootPid || placed.command !== placement.command) return held('pane changed during recovery')
          // One paired query is the last asynchronous observation. Never adopt a
          // later process or let a changed outer shell stand in for the original.
          const final = await probe([root.pid, engine.pid], 0, budget, false)
          if (!final.rows.has(root.pid) || !final.rows.has(engine.pid)
            || controlIdentity(final.rows.get(root.pid)!) !== rootIdentity || controlIdentity(final.rows.get(engine.pid)!) !== evidence
            || final.rows.get(engine.pid)!.directEntryDigest !== engine.directEntryDigest) {
            return held('pane or engine incarnation changed during recovery')
          }
          const verifyExecution = () => { receipt.verify(); current() }
          const verifyConfirmation = () => { receipt.verifyConfirmation(); current() }
          const verify = () => { receipt.verify(); verifyFence(); current() }
          verify()
          const processIdentity = Object.freeze({ pid: observed.pid, executable: observed.executable,
            startMarker: observed.startMarker, ...(observed.startTicks === undefined ? {} : { startTicks: observed.startTicks }) })
          const source = Object.freeze({ target: nativeTurnTarget(row), controlFingerprint: creationFingerprint(control),
            requestFingerprint: creationFingerprint(expected) })
          return Object.freeze({ key, evidence, verify, verifyExecution, verifyConfirmation, current, source, processIdentity, pane: selectedPane! })
        } finally { running--; clearTimeout(timer); settle() }
      }
      return new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          expired = true
          try { held('evidence deadline expired') } catch (error) { reject(error) }
        }, timeout)
        // Expiring the reply cannot free an outstanding OS/file read's slot.
        void observe().then(resolve, reject)
      })
    } catch (error) { settle(); throw error }
  }
  const read = (input: RegisteredSession, request: NativeRelaunchRequest, fence: CreationConfirmationFence,
    recoveryPane?: string | null): NativeRearmObservation => {
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    return Object.assign(result(input, request, fence, settle, recoveryPane), { settled })
  }
  return Object.assign(read, {
    /** The source still has its old PID and permissions. Read only the receipt's
     * original incarnation; never publish a provisional process to make it fit.
     * A saved source's supplied pane is a candidate, proven by token and witness. */
    recover: (source: RegisteredSession, request: NativeRelaunchRequest, fence: CreationConfirmationFence, pane: string) =>
      read(source, request, fence, pane),
    /** Find only the recorded exec's original direct parent, inside this same
     * observation's deadline and actual-I/O slot. The saved pane is historical. */
    recoverSaved: (source: RegisteredSession, request: NativeRelaunchRequest, fence: CreationConfirmationFence) =>
      read(source, request, fence, null),
  })
}
