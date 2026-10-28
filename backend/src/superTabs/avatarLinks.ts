import type { AvatarStore } from './attachments.js'
import type { Avatar } from './profile.js'
import type { SuperTabState } from './model.js'

/** A link is the same through each half hour, so a picture is fetched once in it rather than on every poll, and lasts an
 *  hour from that half hour's start: a copied link stops opening within an hour, and a member removed gets no new one. */
export const AVATAR_LINK_WINDOW_MS = 30 * 60_000
export const AVATAR_LINK_TTL_MS = 60 * 60_000
export const avatarLinkExpiry = (now: number) => Math.floor(now / AVATAR_LINK_WINDOW_MS) * AVATAR_LINK_WINDOW_MS + AVATAR_LINK_TTL_MS

/** Signs at most once per picture and window: signing may call the cloud (IAM signBlob) without a key of our own. */
export class AvatarLinks {
  private readonly signed = new Map<string, string>()
  constructor(private readonly bucket: AvatarStore) {}

  /** A member read's links, by `person:<id>` and `agent:<id>`, for the people and agents it can see that have uploads. */
  async forReader(state: Pick<SuperTabState, 'people'>, agents: Array<{ id: string; avatar?: Avatar }>, now: number): Promise<Record<string, string>> {
    const expiresAt = avatarLinkExpiry(now)
    const holders = [...state.people.map(p => [`person:${p.id}`, p.avatar] as const), ...agents.map(a => [`agent:${a.id}`, a.avatar] as const)]
    const links = await Promise.all(holders.flatMap(([who, avatar]) =>
      avatar?.kind === 'upload' ? [this.link(avatar.key, expiresAt).then(url => [who, url] as const)] : []))
    return Object.fromEntries(links)
  }

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
