import { createPrivateKey, type KeyObject } from 'node:crypto'

/** Apple's push key (a .p8 from the developer account), the ids it is signed with, and the app it sends to. */
export interface ApnsKeys { keyId: string; teamId: string; privateKey: KeyObject; topic: string }
/** The Firebase service account that sends to Android phones. */
export interface FcmAccount { projectId: string; clientEmail: string; privateKey: KeyObject; tokenUri: string }

export interface PushEnv { APNS_KEY_ID: string; APNS_TEAM_ID: string; APNS_PRIVATE_KEY: string; APNS_TOPIC: string; FCM_SERVICE_ACCOUNT: string }

/** A PEM private key with its line breaks as `\n`, or base64 of the file. Errors name the variable, never the value. */
function readKey(name: string, value: string, type: 'ec' | 'rsa'): KeyObject {
  let pem = value.trim().replace(/\\n/g, '\n')
  if (!pem.includes('-----BEGIN')) {
    const decoded = /^[A-Za-z0-9+/=\s]+$/.test(pem) ? Buffer.from(pem, 'base64').toString('utf8') : ''
    if (!decoded.includes('-----BEGIN')) throw new Error(`${name} is not a PEM private key or base64 of one.`)
    pem = decoded.trim()
  }
  let key: KeyObject
  try { key = createPrivateKey(pem) } catch { throw new Error(`${name} could not be read as a private key.`) }
  if (key.asymmetricKeyType !== type) throw new Error(`${name} must be the ${type === 'ec' ? 'P-256 key Apple generated (.p8)' : 'RSA key of the service account'}.`)
  return key
}

function readAccount(value: string): FcmAccount {
  let account: Record<string, unknown>
  try { account = JSON.parse(Buffer.from(value.trim(), 'base64').toString('utf8')) as Record<string, unknown> } catch {
    throw new Error('FCM_SERVICE_ACCOUNT must be base64 of the service account\'s JSON key file.')
  }
  const field = (name: string) => typeof account[name] === 'string' && account[name] ? account[name] as string : null
  const projectId = field('project_id'), clientEmail = field('client_email'), key = field('private_key')
  if (!projectId || !clientEmail || !key) throw new Error('FCM_SERVICE_ACCOUNT must hold project_id, client_email and private_key.')
  return { projectId, clientEmail, privateKey: readKey('FCM_SERVICE_ACCOUNT', key, 'rsa'), tokenUri: field('token_uri') ?? 'https://oauth2.googleapis.com/token' }
}

/**
 * The push keys in the server's secret store (task #2905). Nothing set: that platform's push is off, and each push it skips
 * is counted (push/send.ts). The APNs values set in part, or a key that cannot be right, stops the server at start rather
 * than failing the first notice.
 */
export function pushKeysFromEnv(env: PushEnv): { apns: ApnsKeys | null; fcm: FcmAccount | null } {
  const keyId = env.APNS_KEY_ID.trim(), teamId = env.APNS_TEAM_ID.trim(), key = env.APNS_PRIVATE_KEY.trim()
  let apns: ApnsKeys | null = null
  if (keyId || teamId || key) {
    const missing = [['APNS_KEY_ID', keyId], ['APNS_TEAM_ID', teamId], ['APNS_PRIVATE_KEY', key]].filter(([, v]) => !v).map(([n]) => n)
    if (missing.length) throw new Error(`Set APNS_KEY_ID, APNS_TEAM_ID and APNS_PRIVATE_KEY for phone push, or none: ${missing.join(', ')} missing.`)
    apns = { keyId, teamId, privateKey: readKey('APNS_PRIVATE_KEY', key, 'ec'), topic: env.APNS_TOPIC.trim() }
  }
  return { apns, fcm: env.FCM_SERVICE_ACCOUNT.trim() ? readAccount(env.FCM_SERVICE_ACCOUNT) : null }
}
