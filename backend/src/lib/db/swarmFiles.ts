/**
 * The files the Swarm stored, and their removal (lib/db/swarmDataRemoval.ts). Chat files, their thumbnails and voice messages
 * are in the attachments bucket under the chat folder (`SUPER_TAB_ATTACHMENTS_PREFIX/`); avatars are in the attachments bucket's
 * `avatars/` (production, Ken 2026-10-28, option B1), or in a bucket of their own under the chat folder (SUPER_TAB_AVATARS_BUCKET).
 * Nothing else writes to these folders. A chat folder that is empty would be the whole bucket: it is refused, loudly, and its
 * files are left to someone who can tell them apart.
 *
 * Each pass lists the first PAGE objects left in a folder, removes them, AT_ONCE at a time, and lists again until none are left,
 * for at most PAGES_PER_PASS pages: a removed object is never listed again, so a pass stopped anywhere repeats nothing, and the
 * next one goes on. Counts only in what it returns.
 */
import { logger } from '../../utils/logger.js'

/** Objects listed at a time. */
export const PAGE = 200
/** Removals in flight at once. */
export const AT_ONCE = 8
/** Pages one pass takes at most: 200,000 objects. */
export const PAGES_PER_PASS = 1_000
/** The longest a bucket call may take: one past it fails the pass, which the next one tries again. */
export const CALL_MS = 30_000

/** What the removal needs of a bucket. */
export interface FileStore {
  /** Up to [max] object names under [prefix], in the bucket's order. */
  list(prefix: string, max: number): Promise<string[]>
  /** Removes [name]; one already gone is no error. */
  delete(name: string): Promise<void>
}
/** One folder of one bucket: [prefix] ends with `/` and is never empty. */
export interface Folder { bucket: string; prefix: string; store: FileStore }

/** The settings that say where the Swarm's files are (config/env.ts). */
export interface FileSettings {
  SUPER_TAB_ATTACHMENTS_BUCKET: string
  SUPER_TAB_ATTACHMENTS_CREDENTIALS: string
  SUPER_TAB_ATTACHMENTS_PREFIX: string
  SUPER_TAB_AVATARS_BUCKET: string
}

/** A bucket's store, made from its name: Cloud Storage's in production (gcsStores). */
export type StoreFor = (bucket: string) => FileStore

const trim = (prefix: string) => prefix.replace(/^\/+|\/+$/g, '')
/** The avatars' folder in the attachments bucket when they have no bucket of their own. */
export const SHARED_AVATAR_FOLDER = 'avatars/'

/** The folders the Swarm wrote to, each once. Throws when the chat folder would be the whole bucket. */
export function swarmFolders(settings: FileSettings, storeFor: StoreFor): Folder[] {
  const files = settings.SUPER_TAB_ATTACHMENTS_BUCKET, avatars = settings.SUPER_TAB_AVATARS_BUCKET
  if (!files && !avatars) return []
  const chat = trim(settings.SUPER_TAB_ATTACHMENTS_PREFIX)
  if (!chat) throw Object.assign(new Error('SUPER_TAB_ATTACHMENTS_PREFIX is empty: the chat files would be the whole bucket'), { code: 'EMPTY_PREFIX' })
  const folders = new Map<string, { bucket: string; prefix: string }>()
  const add = (bucket: string, prefix: string) => { if (bucket) folders.set(`${bucket}\u0000${prefix}`, { bucket, prefix }) }
  add(files, `${chat}/`)
  add(files, SHARED_AVATAR_FOLDER)
  add(avatars, `${chat}/`)
  return [...folders.values()].map(folder => ({ ...folder, store: storeFor(folder.bucket) }))
}

/** Counts only: no bucket, name or key. */
export interface FilesPass { objects: number; failed: number; done: boolean }

/** [work], or a failure named BUCKET_TIMEOUT once [ms] pass. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('The bucket did not answer in time'), { code: 'BUCKET_TIMEOUT' })), ms) })
  try { return await Promise.race([work, late]) } finally { clearTimeout(timer) }
}

const codeOf = (error: unknown): string | number | null =>
  error && typeof error === 'object' && 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : null

/** One pass over [folders]: every object in each goes. Not done when stopped, past its pages, or when an object could not be
 *  removed (the next pass lists it first again). A list that fails throws. */
export async function removeSwarmFiles(folders: Folder[], { pause, signal, callMs = CALL_MS, pages = PAGES_PER_PASS }:
  { pause?: () => Promise<void>; signal?: AbortSignal; callMs?: number; pages?: number } = {}): Promise<FilesPass> {
  const pass: FilesPass = { objects: 0, failed: 0, done: false }
  let page = 0
  for (const { prefix, store } of folders) {
    for (;;) {
      if (signal?.aborted || page++ >= pages) return pass
      const names = await within(store.list(prefix, PAGE), callMs)
      // Never a name outside the folder, whatever the store answers.
      const inside = names.filter(name => name.startsWith(prefix))
      if (!inside.length) break
      for (let i = 0; i < inside.length; i += AT_ONCE) {
        await Promise.all(inside.slice(i, i + AT_ONCE).map(async name => {
          try {
            await within(store.delete(name), callMs)
            pass.objects++
          } catch (error) {
            pass.failed++
            logger.warn('[swarm-removal] a stored file could not be removed yet', { code: codeOf(error) })
          }
        }))
      }
      // What failed would be listed first again: the next pass tries it.
      if (pass.failed) return pass
      await pause?.()
    }
  }
  pass.done = true
  return pass
}

/** The base64 of a service account JSON key, or empty for the application default credentials (Workload Identity). A value that is
 *  not one throws; no message repeats any of the value. */
export function serviceAccountFrom(raw: string): { projectId?: string; credentials: { client_email: string; private_key: string } } | null {
  const value = raw.replaceAll(/\s+/g, '')
  if (!value) return null
  const invalid = (): never => { throw Object.assign(new Error('SUPER_TAB_ATTACHMENTS_CREDENTIALS is not the base64 of a service account JSON key'), { code: 'BAD_CREDENTIALS' }) }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) invalid()
  let key: Record<string, unknown> = {}
  try { key = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) } catch { invalid() }
  if (!key || typeof key !== 'object' || typeof key.client_email !== 'string' || !key.client_email
    || typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY')) invalid()
  return { ...(typeof key.project_id === 'string' ? { projectId: key.project_id } : {}),
    credentials: { client_email: key.client_email as string, private_key: key.private_key as string } }
}

/** Cloud Storage's stores, with the attachments' credentials; the client is loaded on first use, so a backend without a bucket
 *  never loads it. */
export function gcsStores(credentials: string): StoreFor {
  const account = serviceAccountFrom(credentials)
  return name => {
    let bucket: Promise<import('@google-cloud/storage').Bucket> | null = null
    const files = () => bucket ??= import('@google-cloud/storage').then(({ Storage }) => new Storage(account ?? undefined).bucket(name))
    return {
      async list(prefix, max) {
        const [found] = await (await files()).getFiles({ prefix, maxResults: max, autoPaginate: false })
        return found.map(file => file.name)
      },
      async delete(objectName) { await (await files()).file(objectName).delete({ ignoreNotFound: true }) },
    }
  }
}
