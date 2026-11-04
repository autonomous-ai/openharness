import { logger } from '../utils/logger.js'
import { errorCode, type AvatarStore } from './attachments.js'
import type { Avatar } from './profile.js'
import type { SuperTabState } from './model.js'

/** A link is the same through each half hour, so a picture is fetched once in it rather than on every poll. It lasts an hour
 *  from that half hour's start, whether the pictures have a bucket of their own or share the chat files' (fileLinks.ts): a
 *  copied link stops opening within an hour once that bucket is private, and a member removed gets no new one. */
export const AVATAR_LINK_WINDOW_MS = 30 * 60_000
export const AVATAR_LINK_TTL_MS = 60 * 60_000
export const avatarLinkExpiry = (now: number) => Math.floor(now / AVATAR_LINK_WINDOW_MS) * AVATAR_LINK_WINDOW_MS + AVATAR_LINK_TTL_MS

/** Signs at most once per picture and window, and reads asking at once share that one signature: signing may call the cloud
 *  (IAM signBlob) without a key of our own. A picture that cannot be signed is left out of that read, never the read itself
 *  (review 1 of #2460): its person shows their default face, and the next read tries again. */
export class AvatarLinks {
  private readonly signed = new Map<string, Promise<string>>()
  /** [folder]: the only keys signed. In the shared attachments bucket a link opens whatever key it names, so a key outside
   *  the avatar folder (a chat file's) never gets one, whatever a record says. Empty: the whole (avatar-only) bucket. */
  constructor(private readonly bucket: AvatarStore, private readonly folder = '') {}

  /** A member read's links, by `person:<id>` and `agent:<id>`, for the people and agents it can see that have uploads. */
  async forReader(state: Pick<SuperTabState, 'people'>, agents: Array<{ id: string; avatar?: Avatar }>, now: number): Promise<Record<string, string>> {
    const expiresAt = avatarLinkExpiry(now)
    const holders = [...state.people.map(p => [`person:${p.id}`, p.avatar] as const), ...agents.map(a => [`agent:${a.id}`, a.avatar] as const)]
    const links = await Promise.all(holders.flatMap(([who, avatar]) =>
      avatar?.kind === 'upload' && this.inFolder(avatar.key) ? [this.link(avatar.key, expiresAt).then(url => [who, url] as const)] : []))
    return Object.fromEntries(links.flatMap(([who, url]) => url === null ? [] : [[who, url] as const]))
  }

  private inFolder(objectKey: string) { return !this.folder || objectKey.startsWith(`${this.folder}/`) }

  /** The window's link to [objectKey], or null when it could not be signed. A failure is not kept, and is logged by its code
   *  alone: storage's message may quote the key. */
  private async link(objectKey: string, expiresAt: number): Promise<string | null> {
    const cacheKey = `${objectKey}@${expiresAt}`
    let pending = this.signed.get(cacheKey)
    if (!pending) {
      // Links of past windows are never asked again.
      for (const key of this.signed.keys()) if (!key.endsWith(`@${expiresAt}`)) this.signed.delete(key)
      pending = this.bucket.signedUrl(objectKey, expiresAt)
      this.signed.set(cacheKey, pending)
    }
    try { return await pending } catch (error) {
      if (this.signed.get(cacheKey) === pending) this.signed.delete(cacheKey)
      logger.warn('[avatar-links] could not sign an avatar link', { code: errorCode(error) })
      return null
    }
  }
}
