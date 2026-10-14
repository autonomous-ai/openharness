/** Stop closes only a retained allocation; it never signals a numeric PID. */
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { NativeArchiveStopProof } from '../../lib/nativeArchive.js'
import { nativePaneAllocationArgs, type NativePaneAllocation, NATIVE_PANE_ALLOCATION_OPTION } from '../../lib/nativePaneAllocation.js'
import { HARNESS_OWNER_OPTION } from '../../lib/harnessSessionLabel.js'
import { NATIVE_LAUNCH_MARKER } from '../../lib/nativePaneHold.js'
import { NATIVE_ALLOCATION_LIMIT } from '../../lib/nativeAllocation.js'
import { probeNativeProcessControl, type NativeControlHelpers } from '../../lib/nativeProcessControlProbe.js'
import { NativeEvidenceBudget, nativeText, nativeUnavailable } from './nativeEvidence.js'
import { nativeHookScope, type NativeHookScope } from './nativeHookScope.js'
import { nativeHookWriterDead, validNativeHookWriter, type NativeHookWriter } from './nativeHookWriter.js'

export interface NativeStopAllocation extends NativePaneAllocation {
  /** This association is selected from durable authority, never today's default
   * socket. A moved/unlinked socket while the old server lives is unavailable. */
  readonly endpoint: { readonly binary: string; readonly socket: string; readonly server: NativeHookWriter }
}
export interface NativePhysicalStopOwner {
  /** Created before allocation selection; neither physical work nor its reply
   * timer may renew the original deadline or replenish consumed work. A later
   * attempt needs fresh selection, not another use of an expired owner. */
  readonly budget: NativeEvidenceBudget
  readonly source: NativeArchiveStopProof['source']
  /** Complete original engine obligations, selected by durable allocation
   * references. An unknown engine cannot be omitted from this list. */
  readonly engines: readonly NativeHookWriter[]
  readonly allocations: readonly NativeStopAllocation[]
  /** Original Registry/Store image, checked before every physical effect. */
  verify(): void
  /** Full retained creation receipts and allocation references, independent of
   * the Registry leaf intentionally consumed by retirement. Includes explicit
   * not-dispatched evidence for every allocation without an engine witness. */
  verifyAllocations(): void
  /** Disk-free cancellation/shutdown fence, valid across intentional retirement. */
  current(): void
}
export interface NativePhysicalStopResult<T> extends Promise<T> { readonly settled: Promise<void> }
export type NativePaneState = 'active' | 'released' | 'absent'
const held = (reason: string): never => nativeUnavailable(`native Stop ${reason}`)

/** Absence needs an entire authoritative inventory. Error text from a timed-out
 * or killed client cannot turn a missing reply into an empty tmux server. */
async function tmux(endpoint: NativeStopAllocation['endpoint'], args: string[], budget: NativeEvidenceBudget): Promise<{ output: string; absent: boolean }> {
  const timeout = budget.probe()
  return new Promise((resolve, reject) => {
    execFile(endpoint.binary, ['-S', endpoint.socket, ...args], { encoding: 'buffer', timeout, killSignal: 'SIGKILL', maxBuffer: 512 * 1024,
      env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined, LC_ALL: '', LANG: 'C', LC_MESSAGES: 'C',
        LC_CTYPE: process.platform === 'darwin' ? 'UTF-8' : 'C.UTF-8' },
    }, (error, stdout, stderr) => {
      try {
        budget.step(stdout.length + stderr.length)
        const output = nativeText(stdout), message = nativeText(stderr)
        const noServer = error?.code === 1 && !error.killed && !error.signal && !output
          && /^(?:no server running on [^\r\n]+|error connecting to [^\r\n]+ \(No such file or directory\))\n$/.test(message)
        if (noServer) { resolve({ output: '', absent: true }); return }
        if (error || message) return held('could not complete its tmux observation')
        resolve({ output, absent: false })
      } catch (error) { reject(error) }
    })
  })
}

function validAllocation(input: NativeStopAllocation): void {
  nativePaneAllocationArgs('close', input)
  if (!input.endpoint || !isAbsolute(input.endpoint.binary) || !isAbsolute(input.endpoint.socket)
    || input.endpoint.binary.includes('\0') || input.endpoint.socket.includes('\0')
    || !validNativeHookWriter(input.endpoint.server)) held('original tmux endpoint is unavailable')
}

export async function readNativeStopPane(input: NativeStopAllocation, budget: NativeEvidenceBudget,
  serverDead: () => Promise<boolean>,
): Promise<NativePaneState> {
  validAllocation(input)
  if (await serverDead()) return 'absent'
  const missingServer = async (): Promise<NativePaneState> => {
    if (await serverDead()) return 'absent'
    return held('original tmux server is alive but its endpoint is unavailable')
  }
  const listing = await tmux(input.endpoint, ['list-panes', '-a', '-F', '#{pid}\t#{pane_id}'], budget)
  if (listing.absent) return missingServer()
  const lines = listing.output.endsWith('\n') ? listing.output.slice(0, -1).split('\n') : []
  const prefix = `${input.endpoint.server.pid}\t`
  if (!lines.length || lines.length > 8192 || lines.some(line => !line.startsWith(prefix) || !/^%[0-9]{1,20}$/.test(line.slice(prefix.length)))
    || new Set(lines).size !== lines.length) return held('original server pane inventory is incomplete')
  // The paired native observation excludes PID reuse by a replacement server.
  if (await serverDead()) return 'absent'
  if (!lines.includes(prefix + input.pane)) return 'absent'
  const result = await tmux(input.endpoint, ['display-message', '-p', '-t', input.pane,
    `#{pid}\n#{pane_id}\n#{pane_pid}\n#{${HARNESS_OWNER_OPTION}}\n#{${NATIVE_PANE_ALLOCATION_OPTION}}\n#{pane_start_command}`], budget)
  if (result.absent) return missingServer()
  if (await serverDead()) return 'absent'
  const [server, pane, pid, owner, marker, ...commandParts] = result.output.split('\n')
  const command = commandParts.join('\n'), launch = `/usr/bin/env ${NATIVE_LAUNCH_MARKER}=${input.token} `
  const tagged = `/usr/bin/env HARNESS_DAEMON=${input.owner} ${launch}`
  if (server !== String(input.endpoint.server.pid) || pane !== input.pane || pid !== String(input.rootPid) || owner !== input.owner
    || !command.endsWith('\n') || command.includes('\0') || !command.startsWith(launch) && !command.startsWith(tagged)) {
    return held('pane belongs to another allocation')
  }
  if (marker === `active:${input.token}:${input.rootPid}`) return 'active'
  if (marker === `released:${input.token}:${input.rootPid}`) return 'released'
  return held('pane allocation marker is unavailable')
}

export async function closeNativeStopPane(input: NativeStopAllocation, budget: NativeEvidenceBudget, verify: () => void): Promise<void> {
  validAllocation(input)
  const args = nativePaneAllocationArgs('close', input)
  args[4] = `#{&&:#{==:#{pid},${input.endpoint.server.pid}},${args[4]}}`
  // Do not put asynchronous preparation between this fence and the command.
  verify(); budget.step()
  await tmux(input.endpoint, args, budget)
  // Even a successful command needs a subsequent complete observation. A lost
  // reply remains held; retrying this guarded close cannot affect a successor.
}

/** The consumer is synchronous and owns Registry's compare-and-publish. The
 * producer keeps receipt and directory proofs alive until that call finishes.
 * Expiring the reply never frees an outstanding native I/O or descriptor slot. */
export function createNativePhysicalStop({ roots, helpers, scope = nativeHookScope, dead = nativeHookWriterDead,
  readPane = readNativeStopPane, closePane = closeNativeStopPane,
}: {
  roots: readonly string[]
  helpers: NativeControlHelpers
  scope?: typeof nativeHookScope
  dead?: typeof nativeHookWriterDead
  readPane?: typeof readNativeStopPane
  closePane?: typeof closeNativeStopPane
}) {
  const locations = [...roots]
  let running = 0, closed = false
  const stop = <T>(input: NativePhysicalStopOwner, consume: (proof: NativeArchiveStopProof) => T & (T extends PromiseLike<unknown> ? never : unknown)): NativePhysicalStopResult<T> => {
    let settle!: () => void, launched = false
    const settled = new Promise<void>(resolve => { settle = resolve })
    const result = async (): Promise<T> => {
      let occupied = false, active = true, expired = false, timer: ReturnType<typeof setTimeout> | undefined
      const retained: NativeHookScope[] = []
      const budget = input.budget
      const source = Object.freeze({ ...input.source }), engines = structuredClone(input.engines), allocations = structuredClone(input.allocations)
      const { verify: verifyOwner, verifyAllocations, current: ownerCurrent } = input
      const current = () => {
        if (!active || expired || closed) return held('authority expired or was revoked')
        budget.step(); ownerCurrent(); budget.step()
        if (!active || expired || closed) return held('authority expired or was revoked')
      }
      const verifyStopped = () => {
        retained.forEach((proof, index) => proof.verify(locations[index]))
        verifyAllocations(); current()
      }
      const verify = () => { verifyStopped(); verifyOwner(); current() }
      const probe = (pids: readonly number[], work: NativeEvidenceBudget) => probeNativeProcessControl(pids, 0, work, false, helpers)
      const work = async (): Promise<T> => {
        try {
          if (!/^[a-f0-9]{64}$/.test(source.target) || !/^[a-f0-9]{64}$/.test(source.controlFingerprint)
            || !engines.length || engines.length > NATIVE_ALLOCATION_LIMIT + 2 || engines.some(engine => !validNativeHookWriter(engine))
            || allocations.length > NATIVE_ALLOCATION_LIMIT + 1 || !locations.length || locations.length > 2
            || locations.some(root => !isAbsolute(root)) || new Set(locations).size !== locations.length) return held('original ownership is incomplete')
          allocations.forEach(validAllocation)
          if (new Set(allocations.map(({ endpoint, pane }) => JSON.stringify([endpoint.server.boot, endpoint.server.namespace,
            endpoint.server.pid, endpoint.server.birth, pane]))).size !== allocations.length) return held('pane ownership is ambiguous')
          current()
          if (running >= 4) return held('physical evidence slots are occupied')
          running++; occupied = true
          verify()
          for (const root of locations) {
            const proof = await scope(root, budget, helpers)
            retained.push(proof); verify()
            if (retained[0].boot !== proof.boot || retained[0].namespace !== proof.namespace) return held('local process scope differs')
          }
          for (const allocation of allocations) {
            const serverDead = () => dead(locations[0], allocation.endpoint.server, budget, probe, helpers)
            const state = await readPane(allocation, budget, serverDead)
            verify()
            if (state === 'active') {
              await closePane(allocation, budget, verify)
              verify()
              if (await readPane(allocation, budget, serverDead) === 'active') return held('original allocation is still open')
              verify()
            }
          }
          // Closing the pane does not prove that an engine which detached from
          // it has exited. Exact positive death evidence is independently required.
          for (const engine of engines) {
            if (!await dead(locations[0], engine, budget, probe, helpers)) return held('original engine is still running')
            verify()
          }
          for (let index = 0; index < locations.length; index++) {
            const final = await scope(locations[index], budget, helpers)
            try {
              verify(); final.verify(locations[index])
              const before = retained[index]
              if (before.boot !== final.boot || before.namespace !== final.namespace || before.storage !== final.storage) return held('local process scope changed')
            } finally { final.close() }
            verify()
          }
          verify()
          const proof = Object.freeze({ source, verifyStopped, current })
          const answer = consume(proof)
          if (answer && (typeof answer === 'object' || typeof answer === 'function') && typeof (answer as { then?: unknown }).then === 'function') {
            void Promise.resolve(answer).catch(() => {})
            return held('retirement consumer must be synchronous')
          }
          verifyStopped()
          return answer
        } finally {
          active = false
          try {
            // Attempt every owned close even if one reports an uncertain error.
            let failure: unknown
            for (const proof of retained) { try { proof.close() } catch (error) { failure ??= error } }
            if (failure) throw failure
          } finally { if (occupied) running--; clearTimeout(timer); settle() }
          if (expired || closed) return held('authority expired during cleanup')
          budget.step(); ownerCurrent(); budget.step()
          if (expired || closed) return held('authority expired during cleanup')
        }
      }
      return new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => { expired = true; try { held('evidence deadline expired') } catch (error) { reject(error) } }, budget.remaining())
        launched = true
        void work().then(resolve, reject)
      })
    }
    // Invalid caller data can fail before work owns a slot or descriptor.
    return Object.assign(result().catch(error => { if (!launched) settle(); throw error }), { settled })
  }
  return Object.assign(stop, { close() { closed = true } })
}
