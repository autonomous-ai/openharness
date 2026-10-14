/** Host, PID-view and local-volume evidence for reclaiming private hook stages. */
import { execFile } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync, statfsSync, statSync } from 'node:fs'
import type { NativeControlHelpers } from '../../lib/nativeProcessControlProbe.js'
import { IdentityReadUnavailable } from './identityScan.js'
import { NativeEvidenceBudget, nativeBytes, nativeText, nativeUnavailable } from './nativeEvidence.js'
import { kernelBootId } from './nativeHookBoot.js'
import { NativePaths, verifyNativePathFacts } from './nativePaths.js'

export interface NativeHookScope { boot: string; namespace: string; storage: string; verify(root: string): void; close(): void }
const decimal = /^(?:0|[1-9][0-9]{0,19})$/
const localLinux = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x2fc12fc1n])
let retainedScopes = 0
const unavailable = (reason: string): never => nativeUnavailable(`the native hook storage scope ${reason}`)

/** No host-name/configuration fallback: an unreadable or remote scope holds.
 * The same fresh probe brackets every death proof, including kernel reboot. */
export async function nativeHookScope(root: string, budget: NativeEvidenceBudget, helpers: NativeControlHelpers): Promise<NativeHookScope> {
  const paths = new NativePaths(budget), location = paths.resolveSync(root)!, facts = paths.snapshot()
  if (!location.info.isDirectory()) return unavailable('is not a directory')
  if (retainedScopes >= 32) return unavailable('descriptor capacity is occupied')
  let fd: number | undefined
  let retained = false, closed = false
  const close = () => {
    if (closed) return
    closed = true
    // A close error leaves actual closure uncertain. Retain that capacity slot
    // and never retry the numeric FD, which the OS might already have reused.
    if (fd !== undefined) { closeSync(fd); retainedScopes-- }
  }
  const verify = (input = root) => {
    if (closed) unavailable('was closed')
    if (input !== root) unavailable('belongs to another root')
    verifyNativePathFacts(facts)
    if (fd === undefined) unavailable('has no retained descriptor')
    const now = fstatSync(fd!, { bigint: true })
    if (!now.isDirectory() || now.dev !== location.info.dev || now.ino !== location.info.ino) unavailable('changed its root')
  }
  let namespace: string, storage: string
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    fd = openSync(location.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    retainedScopes++
    verify()
    const before = await kernelBootId(budget)
    if (process.platform === 'linux') {
      const pidView = () => {
        budget.step()
        if (readlinkSync('/proc/self') !== String(process.pid)) return unavailable('has a different proc PID view')
        const info = statSync('/proc/self/ns/pid', { bigint: true })
        if (!info.isFile() || info.ino <= 0n || info.dev < 0n) return unavailable('has no PID namespace identity')
        return `linux:${info.dev}:${info.ino}`
      }
      const self = nativeText(await nativeBytes('/proc/self/status', 64 * 1024, budget))
      for (const key of ['NStgid', 'NSpid']) {
        const rows = self.split('\n').filter(line => line.startsWith(key + ':'))
        if (rows.length !== 1 || !new RegExp(`^${key}:\\s+${process.pid}$`).test(rows[0])) return unavailable('has a different proc PID namespace view')
      }
      namespace = pidView()
      verify()
      const volume = statfsSync(`/proc/self/fd/${fd}`, { bigint: true })
      if (!localLinux.has(volume.type)) return unavailable('is not a supported local filesystem')
      const mountFd = openSync(`/proc/self/fdinfo/${fd}`, constants.O_RDONLY | constants.O_NONBLOCK)
      let raw: string
      try {
        const bytes = Buffer.alloc(4097), size = readSync(mountFd, bytes, 0, bytes.length, 0)
        if (size >= bytes.length || readSync(mountFd, Buffer.alloc(1), 0, 1, size)) return unavailable('has incomplete mount evidence')
        raw = nativeText(bytes.subarray(0, size))
      } finally { closeSync(mountFd) }
      const mounts = raw.split('\n').filter(line => line.startsWith('mnt_id:'))
      if (mounts.length !== 1 || !/^mnt_id:\s+[1-9][0-9]{0,19}$/.test(mounts[0])) return unavailable('has no mount identity')
      storage = `linux:${location.info.dev}:${location.info.ino}:${volume.type}:${mounts[0].split(/\s+/)[1]}`
      if (pidView() !== namespace) return unavailable('changed during inspection')
    } else if (process.platform === 'darwin') {
      const helper = await Promise.race([helpers.prepare(), new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), budget.remaining())
      })])
      if (!helper) return unavailable('helper is unavailable')
      const timeout = budget.probe()
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        execFile(helper.path, ['--scope', String(Math.min(timeout, 3000)), location.path],
          { encoding: 'buffer', timeout, maxBuffer: 1024, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
            if (error && ['ENOENT', 'ENOTDIR', 'EACCES', 'ENOEXEC'].includes(String(error.code))) helpers.invalidate(helper.key)
            if (error || stderr.length) reject(new IdentityReadUnavailable('the native hook storage scope helper did not complete'))
            else resolve(stdout)
          })
      })
      budget.step(bytes.length)
      const text = nativeText(bytes), row = JSON.parse(text)
      if (!text.endsWith('\n') || row?.schema !== 1 || row.mode !== 'scope'
        || typeof row.device !== 'string' || !decimal.test(row.device) || row.device !== String(location.info.dev)
        || typeof row.inode !== 'string' || !decimal.test(row.inode) || row.inode !== String(location.info.ino)
        || typeof row.mount !== 'string' || !/^-?\d{1,10}:-?\d{1,10}$/.test(row.mount)
        || !['apfs', 'hfs'].includes(row.filesystem) || !Number.isInteger(row.type) || row.type <= 0 || row.type > 0xffffffff) return unavailable('helper reply is incomplete')
      namespace = 'darwin'
      storage = `darwin:${row.device}:${row.inode}:${row.filesystem}:${row.mount}`
    } else return unavailable('is unsupported on this platform')
    verify(root)
    if (await kernelBootId(budget) !== before) return unavailable('changed its boot during inspection')
    verify(root)
    // The retained directory FD pins the admitted filesystem; route identity
    // checks cannot accidentally accept an unmounted/recycled device or inode.
    // Keep it until actual staging work and cleanup have settled.
    retained = true
    return Object.freeze({ boot: before, namespace, storage, verify, close })
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    return unavailable('could not be read completely')
  } finally { if (timer) clearTimeout(timer); if (!retained) close() }
}
