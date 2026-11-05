import { sign } from 'node:crypto'
import type { FcmAccount } from './keys.js'
import { SEND_TIMEOUT_MS, SWARM_CHANNEL, SWARM_QUIET_CHANNEL, withTimeout, type Sender } from './sender.js'

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
/** An access token is used until this long before Google says it runs out. */
const RENEW_BEFORE_MS = 5 * 60_000

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

type GoogleError = { error?: { status?: string; details?: Array<{ errorCode?: string }> } }

/**
 * Sends to Android phones through FCM's HTTP v1 API, signed in as the service account with a JWT grant (task #2905). The
 * message is a notification Android draws itself while the app is closed, in the channel of the app's own Swarm notices, and
 * never draws while the app is in front: there the app's own notices decide.
 */
export function fcmSender(account: FcmAccount, options: { fetcher?: typeof fetch; now?: () => number; timeoutMs?: number } = {}): Sender {
  const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS
  let access: { token: string; until: number } | null = null
  const call = (url: string, init: RequestInit) => withTimeout(fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }), timeoutMs)
  const accessToken = async () => {
    const at = now()
    if (access && at < access.until - RENEW_BEFORE_MS) return access.token
    const iat = Math.floor(at / 1000)
    const signed = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: account.clientEmail, scope: SCOPE,
      aud: account.tokenUri, iat, exp: iat + 3600 }))}`
    const assertion = `${signed}.${base64url(sign('sha256', Buffer.from(signed), account.privateKey))}`
    const answer = await call(account.tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() })
    if (!answer.ok) throw new Error(`sign-in ${answer.status}`)
    const granted = await answer.json() as { access_token?: string; expires_in?: number }
    if (!granted.access_token) throw new Error('sign-in gave no token')
    access = { token: granted.access_token, until: at + (granted.expires_in ?? 3600) * 1000 }
    return access.token
  }
  return {
    async send(device, notice) {
      try {
        const answer = await call(`https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`, {
          method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
          body: JSON.stringify({ message: {
            token: device.token,
            // Android's notification has no subtitle: the project leads the body, as the local notice's subtext shows it.
            notification: { title: notice.title, body: notice.subtitle ? `${notice.subtitle} · ${notice.body}` : notice.body },
            // Tagged with its slot (task #3248): Android replaces a notification of the same tag, so a thread's replies share
            // one, and the app posts its own notice for it under the same tag. A quiet one goes on the app's silent channel.
            android: { priority: 'high', notification: { channel_id: notice.quiet ? SWARM_QUIET_CHANNEL : SWARM_CHANNEL, tag: notice.slot, visibility: 'PRIVATE' } },
            data: { key: notice.key, link: notice.link, slot: notice.slot },
          } }),
        })
        if (answer.ok) return { outcome: 'sent' }
        const error = (await answer.json().catch(() => ({})) as GoogleError).error
        if (answer.status === 401) access = null
        const code = error?.details?.find(d => d.errorCode)?.errorCode
        if (code === 'UNREGISTERED') return { outcome: 'gone', reason: code }
        return { outcome: 'failed', reason: code ?? error?.status ?? String(answer.status) }
      } catch (error) {
        const name = (error as Error).name, message = (error as Error).message
        return { outcome: 'failed', reason: message === 'timeout' || name === 'TimeoutError' ? 'timeout' : message }
      }
    },
  }
}
