import type { AvatarStore } from './attachments.js'
import type { Avatar } from './profile.js'
import type { SuperTabState } from './model.js'

/** A link is the same through each half hour, so a picture is fetched once in it rather than on every poll. In a private
 *  avatar bucket it lasts an hour from that half hour's start: a copied link stops opening within an hour, and a member
 *  removed gets no new one. On the attachments CDN (no avatar bucket) it is the picture's permanent address. */
export const AVATAR_LINK_WINDOW_MS = 30 * 60_000
export const AVATAR_LINK_TTL_MS = 60 * 60_000
export const avatarLinkExpiry = (now: number) => Math.floor(now / AVATAR_LINK_WINDOW_MS) * AVATAR_LINK_WINDOW_MS + AVATAR_LINK_TTL_MS

/** Signs at most once per picture and window: signing may call the cloud (IAM signBlob) without a key of our own. */
export class AvatarLinks {
  private readonly signed = new Map<string, string>()
  /** [folder]: the only keys signed. In the shared attachments bucket a link opens whatever key it names, so a key outside
   *  the avatar folder (a chat file's) never gets one, whatever a record says. Empty: the whole (avatar-only) bucket. */
  constructor(private readonly bucket: AvatarStore, private readonly folder = '') {}

  /** A member read's links, by `person:<id>` and `agent:<id>`, for the people and agents it can see that have uploads. */
  async forReader(state: Pick<SuperTabState, 'people'>, agents: Array<{ id: string; avatar?: Avatar }>, now: number): Promise<Record<string, string>> {
    const expiresAt = avatarLinkExpiry(now)
    const holders = [...state.people.map(p => [`person:${p.id}`, p.avatar] as const), ...agents.map(a => [`agent:${a.id}`, a.avatar] as const)]
    const links = await Promise.all(holders.flatMap(([who, avatar]) =>
      avatar?.kind === 'upload' && this.inFolder(avatar.key) ? [this.link(avatar.key, expiresAt).then(url => [who, url] as const)] : []))
    return Object.fromEntries(links)
  }

  private inFolder(objectKey: string) { return !this.folder || objectKey.startsWith(`${this.folder}/`) }

  private async link(objectKey: string, expiresAt: number): Promise<string> {
    const cached = this.signed.get(`${objectKey}@${expiresAt}`)
    if (cached) return cached
    const url = await this.bucket.signedUrl(objectKey, expiresAt)
    // Links of past windows are never asked again.
    for (const key of this.signed.keys()) if (!key.endsWith(`@${expiresAt}`)) this.signed.delete(key)
    this.signed.set(`${objectKey}@${expiresAt}`, url)
    return url
  }
}
