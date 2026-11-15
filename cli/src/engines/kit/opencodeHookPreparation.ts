/** The existing OpenCode publisher coordination, shared by core and explicit CLI installation. */
import { hookPreparationRoutes, type HookPreparationOptions, type HookPreparationProof } from './nativeHookFiles.js'
import type { NativeHookOptions } from './nativeLocations.js'
import type { OpencodeLaunchSnapshot } from '../launchControl.js'
import { OPENCODE_VERSION } from '../opencode/contract.js'

/** Install both discovery surfaces for v1; v2 must not load our incompatible v1 export. */
interface OpencodeInstallation { port: number; executable?: string; major?: number | null; settling?: boolean; done: Promise<boolean>; proofs: HookPreparationProof[] }
const opencodeInstallations = new Map<string, { current: OpencodeInstallation; users: number }>()
async function waitForInstallation(installation: OpencodeInstallation, deadline: number): Promise<boolean | null> {
  const remaining = deadline - performance.now()
  if (remaining <= 0) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([installation.done, new Promise<null>(done => {
      timer = setTimeout(() => done(null), remaining)
    })])
  } finally { clearTimeout(timer) }
}
export async function prepareOpencodeHooks(paths: readonly string[], port: number, snapshot: OpencodeLaunchSnapshot | undefined, options: NativeHookOptions,
  publish: (major: number | null, authority: HookPreparationOptions) => Promise<boolean>): Promise<boolean> {
  const deadline = performance.now() + (options.timeoutMs ?? OPENCODE_VERSION.timeoutMs)
  let routes: ReturnType<typeof hookPreparationRoutes>
  try { routes = hookPreparationRoutes(paths) } catch { return false }
  const installation: OpencodeInstallation = { port, executable: snapshot?.identity, done: Promise.resolve(false), proofs: [] }
  // Parent aliases can give startup and a captured launch different spellings
  // for the same pair. Each caller still retains its own original route proof.
  const reservation = JSON.stringify(routes.keys)
  if (opencodeInstallations.size >= 128 && !opencodeInstallations.has(reservation)) return false
  const previous = opencodeInstallations.get(reservation)?.current
  const group = opencodeInstallations.get(reservation) ?? { current: installation, users: 0 }
  // Include callers waiting before the lower-level disk reservation. Overflow
  // cannot supersede an admitted owner or grow an unbounded promise chain.
  if (group.users >= 16) return false
  group.current = installation; group.users++
  opencodeInstallations.set(reservation, group)
  try {
  installation.done = (async () => {
    const major = snapshot ? snapshot.major : (await options.setup?.opencodeMajor() ?? null)
    installation.major = major
    // A newer request may have installed an upgraded/downgraded engine's hooks
    // while this probe waited. Only the latest request can change those files.
    if (installation !== group.current || snapshot?.current() === false) return false
    // Readiness can precede the maintenance write. A launch has a captured
    // executable; maintenance does not, so their publications cannot be joined.
    // Revoke the older owner through group.current, let its disk work settle,
    // then inspect and prove this launch's own outputs within the same deadline.
    if (previous && (previous.settling || previous.major !== undefined
      && (previous.port !== port || previous.executable !== installation.executable || previous.major !== major))) {
      installation.settling = true
      const settled = await waitForInstallation(previous, deadline)
      installation.settling = false
      if (settled === null || installation !== group.current || snapshot?.current() === false || options.current?.() === false) return false
    }
    // Keep the existing first-install route until installer-only continuation
    // can return through launch preparation. A missing executable also gives
    // null here; refusing it would prevent create from reaching its installer.
    // Whole-launch preparation must confirm a version before native dispatch.
    try { routes.verify(); return await publish(major, { ...options, timeoutMs: Math.max(0, deadline - performance.now()), confirmed: proof => installation.proofs.push(proof), identity: JSON.stringify([port, snapshot?.identity, major]),
      current: () => group.current.port === port && group.current.executable === installation.executable
        && group.current.major === major && performance.now() < deadline && snapshot?.current() !== false && options.current?.() !== false }) } catch (error) {
      console.error('[hooks] OpenCode preparation held:', error)
      return false
    }
  })()
  let current = installation, installed = await current.done
  while (current !== group.current) {
    current = group.current
    // Two healthy creates must not fail merely because they overlap. Follow the
    // current installation without restoring an obsolete request's write rights.
    // A port change or continuing churn cannot make this caller wait forever.
    const remaining = deadline - performance.now()
    if (current.port !== port || current.executable !== installation.executable || snapshot?.current() === false || options.current?.() === false || remaining <= 0) return false
    const result = await waitForInstallation(current, deadline)
    if (result === null) return false
    installed = result
  }
  if (!installed || performance.now() >= deadline || options.current?.() === false || snapshot?.current() === false || current.proofs.some(proof => !proof.current())) return false
  if (performance.now() >= deadline) return false
  try { routes.verify() } catch { return false }
  if (performance.now() >= deadline || options.current?.() === false || snapshot?.current() === false) return false
  for (const proof of current.proofs) options.confirmed?.({ ...proof, current: () => {
    try { routes.verify(); return proof.current() } catch { return false }
  } })
  return true
  } finally { if (--group.users === 0) opencodeInstallations.delete(reservation) }
}
