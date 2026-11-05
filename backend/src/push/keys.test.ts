import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { pushKeysFromEnv } from './keys.js'

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const account = { type: 'service_account', project_id: 'harness-push', client_email: 'push@harness-push.iam.gserviceaccount.com',
  private_key: rsa, token_uri: 'https://oauth2.googleapis.com/token' }
const none = { APNS_KEY_ID: '', APNS_TEAM_ID: '', APNS_PRIVATE_KEY: '', APNS_SANDBOX_KEY_ID: '', APNS_SANDBOX_PRIVATE_KEY: '', APNS_TOPIC: 'ai.autonomous.harness.ios',
  FCM_SERVICE_ACCOUNT: '' }
const ec2 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const apns = { ...none, APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456', APNS_PRIVATE_KEY: ec.replace(/\n/g, '\\n') }
const fcm = { ...none, FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(account)).toString('base64') }

describe('push keys from the server\'s secret store (task #2905)', () => {
  it('is off for both platforms with nothing set', () => {
    expect(pushKeysFromEnv(none)).toEqual({ apns: null, fcm: null })
  })

  it('reads the APNs key as Apple hands it out, with its line breaks as \\n or as base64 of the .p8 file', () => {
    for (const key of [apns.APNS_PRIVATE_KEY, Buffer.from(ec).toString('base64')]) {
      const keys = pushKeysFromEnv({ ...apns, APNS_PRIVATE_KEY: key })
      expect(keys.apns).toMatchObject({ teamId: 'TEAM123456', topic: 'ai.autonomous.harness.ios', production: { keyId: 'ABC123DEFG' }, sandbox: null })
      expect(keys.apns!.production.privateKey.asymmetricKeyType).toBe('ec')
    }
  })

  it('reads Apple\'s sandbox key beside the production one: each key signs for its own host alone (Ken, 11-05)', () => {
    const keys = pushKeysFromEnv({ ...apns, APNS_SANDBOX_KEY_ID: '5UTFPCN7LP', APNS_SANDBOX_PRIVATE_KEY: Buffer.from(ec2).toString('base64') })
    expect(keys.apns).toMatchObject({ production: { keyId: 'ABC123DEFG' }, sandbox: { keyId: '5UTFPCN7LP' } })
    expect(keys.apns!.sandbox!.privateKey.asymmetricKeyType).toBe('ec')
  })

  it('stops the server when the sandbox key is set in part, or without the production key, naming what is missing', () => {
    expect(() => pushKeysFromEnv({ ...apns, APNS_SANDBOX_KEY_ID: '5UTFPCN7LP' })).toThrow(/APNS_SANDBOX_PRIVATE_KEY/)
    expect(() => pushKeysFromEnv({ ...apns, APNS_SANDBOX_PRIVATE_KEY: ec2 })).toThrow(/APNS_SANDBOX_KEY_ID/)
    expect(() => pushKeysFromEnv({ ...none, APNS_SANDBOX_KEY_ID: '5UTFPCN7LP', APNS_SANDBOX_PRIVATE_KEY: ec2 })).toThrow(/APNS_KEY_ID/)
  })

  it('reads the Firebase service account from base64 of its JSON file', () => {
    expect(pushKeysFromEnv(fcm).fcm).toMatchObject({ projectId: 'harness-push', clientEmail: account.client_email, tokenUri: account.token_uri })
  })

  it('stops the server when the APNs values are set in part, naming what is missing', () => {
    expect(() => pushKeysFromEnv({ ...apns, APNS_TEAM_ID: '' })).toThrow(/APNS_TEAM_ID/)
    expect(() => pushKeysFromEnv({ ...none, APNS_PRIVATE_KEY: apns.APNS_PRIVATE_KEY })).toThrow(/APNS_KEY_ID/)
  })

  it('stops the server on a key that cannot be right, and never repeats it', () => {
    const cases = [{ ...apns, APNS_PRIVATE_KEY: 'not-a-key-SECRET' }, { ...apns, APNS_SANDBOX_KEY_ID: '5UTFPCN7LP', APNS_SANDBOX_PRIVATE_KEY: 'not-a-key-SECRET' }, { ...apns, APNS_PRIVATE_KEY: rsa.replace(/\n/g, '\\n') },
      { ...none, FCM_SERVICE_ACCOUNT: 'SECRETnotbase64json' }, { ...none, FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify({ ...account, private_key: 'SECRET' })).toString('base64') },
      { ...none, FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify({ ...account, project_id: '' })).toString('base64') }]
    for (const env of cases) {
      let message = ''
      try { pushKeysFromEnv(env) } catch (error) { message = (error as Error).message }
      expect(message).toMatch(/APNS_PRIVATE_KEY|APNS_SANDBOX_PRIVATE_KEY|FCM_SERVICE_ACCOUNT/)
      expect(message).not.toMatch(/SECRET|BEGIN/)
    }
  })
})
