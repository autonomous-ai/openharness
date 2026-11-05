import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { metrics } from '../lib/metrics.js'
import { devicesOf, forgetPushDevice, markSandbox, type PushDevice, type PushPlatform } from './devices.js'
import { apnsSender } from './apns.js'
import { fcmSender } from './fcm.js'
import { pushKeysFromEnv, type PushEnv } from './keys.js'
import type { PhoneNotice, Sender } from './sender.js'

/** A platform's sender, or null when the server has no keys for it. */
export type PhoneSenders = Record<PushPlatform, Sender | null>

/** Sends to Apple and Google at once: a 100-person thread's reply is done in a few rounds without opening 100 streams. */
const AT_ONCE = 8

/** The senders the server's secret store allows (push/keys.ts); a bad key throws, which stops the server at start. */
export function phoneSendersFromEnv(env: PushEnv): PhoneSenders {
  const keys = pushKeysFromEnv(env)
  const senders = { ios: keys.apns && apnsSender(keys.apns), android: keys.fcm && fcmSender(keys.fcm) }
  logger.info('phone push', { ios: senders.ios ? 'on' : 'off: no APNs key', android: senders.android ? 'on' : 'off: no FCM service account' })
  return senders
}

/**
 * Sends `notices` to the phones of the people they are for (task #2905), after the write that made them committed. One read
 * of those people's phones; each notice to each of its person's phones, AT_ONCE at a time. A dead token is forgotten, a
 * sandbox one remembered. It never throws: what failed is logged, by platform and Apple's or Google's reason, and counted.
 */
export async function sendPhoneNotices(db: PrismaClient, senders: PhoneSenders, notices: PhoneNotice[]): Promise<void> {
  if (!notices.length) return
  const started = Date.now()
  try {
    const phones = new Map<string, PushDevice[]>()
    for (const device of await devicesOf(db, [...new Set(notices.map(n => n.personId))])) phones.set(device.userId, [...phones.get(device.userId) ?? [], device])
    const sends = notices.flatMap(notice => (phones.get(notice.personId) ?? []).map(device => ({ notice, device })))
    const skipped: Partial<Record<PushPlatform, number>> = {}
    const counts: Record<string, number> = {}
    let next = 0
    const lane = async () => {
      while (next < sends.length) {
        const { notice, device } = sends[next++]!
        const sender = senders[device.platform]
        if (!sender) {
          skipped[device.platform] = (skipped[device.platform] ?? 0) + 1
          metrics.phonePush(device.platform, 'unconfigured')
          continue
        }
        const result = await sender.send(device, notice)
        counts[result.outcome] = (counts[result.outcome] ?? 0) + 1
        metrics.phonePush(device.platform, result.outcome)
        if (result.outcome === 'gone') await forgetPushDevice(db, device.id)
        if (result.outcome === 'sandbox') await markSandbox(db, device.id)
        if (result.outcome === 'failed') logger.warn('phone push failed', { platform: device.platform, reason: result.reason })
      }
    }
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, sends.length) }, lane))
    for (const [platform, count] of Object.entries(skipped)) {
      logger.warn('phone push off: no keys for this platform', { platform, skipped: count, fix: 'set the APNs or FCM keys in the backend secret store (config/env.ts)' })
    }
    if (sends.length) logger.info('phone push', { notices: notices.length, phones: sends.length, ...counts, ms: Date.now() - started })
  } catch (error) {
    logger.warn('phone push failed', { notices: notices.length, error: error instanceof Error ? error.message : String(error) })
  }
}
