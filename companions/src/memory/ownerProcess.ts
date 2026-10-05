import { execFile } from 'node:child_process'

type ReadUid = (pid: number) => Promise<string | null>
const readUid: ReadUid = pid => new Promise(resolve => {
  execFile('ps', ['-p', String(pid), '-o', 'uid='], { timeout: 1_500, maxBuffer: 4_096 },
    (error, stdout) => resolve(error ? null : String(stdout)))
})

/** Loopback is not authentication: another OS user's process must not read this owner's library. */
export async function isOwnerProcess(pid: number, uid: number | undefined = process.getuid?.(), read: ReadUid = readUid): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(uid) || Number(uid) < 0) return false
  const value = await read(pid).catch(() => null)
  return typeof value === 'string' && /^\s*\d+\s*$/.test(value) && Number(value.trim()) === uid
}
