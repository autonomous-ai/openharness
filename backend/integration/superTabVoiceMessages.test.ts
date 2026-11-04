import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore, type VoiceTranscription } from '../src/superTabs/store.js'
import { MemoryAttachmentStore } from '../src/superTabs/attachments.js'
import { logger } from '../src/utils/logger.js'

// Chat voice messages (task #2584): the phone uploads a WAV, the server transcribes it once before it is sent, and the words
// become the message's text, so agents read them in the delivery written with the message.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '230000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '230000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_voice_messages_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, peer]) {
    await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  }
  await db.machine.create({ data: { machineId: 'mac', userId: owner.sub, apiKey: 'fixture-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
}, 120_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** 16 kHz mono 16-bit PCM WAV, [seconds] long, loud. */
function wav(seconds: number): Buffer {
  const samples = Math.round(seconds * 16_000)
  const out = Buffer.alloc(44 + samples * 2)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + samples * 2, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(16_000, 24)
  out.writeUInt32LE(32_000, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) out.writeInt16LE(i % 2 ? 9_000 : -9_000, 44 + i * 2)
  return out
}

/** The transcription service and the daily voice quota, faked: what each was asked, and what each answers. */
function fakeVoice(words = 'Ship the parser today.') {
  const calls = { transcribe: 0, reserved: [] as string[], committed: [] as string[], released: [] as string[] }
  const voice: VoiceTranscription & { calls: typeof calls; answer: () => Promise<string>; quota: 'ok' | 'limit' } = {
    calls, quota: 'ok', answer: async () => words,
    async reserve(_user, id) { calls.reserved.push(id); return voice.quota },
    async transcribe() { calls.transcribe++; return voice.answer() },
    async commit(id) { calls.committed.push(id) },
    async release(id) { calls.released.push(id) },
  }
  return voice
}

async function swarm(voice = fakeVoice(), now: () => number = Date.now) {
  const files = new MemoryAttachmentStore()
  const store = new SuperTabStore(db, now, { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test' }, { voice })
  const tab = (await store.create(owner, randomUUID(), 'Voice', 'public')).id
  const execute = (command: Parameters<SuperTabStore['execute']>[2]['command'], user = owner, asAgentId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  await execute({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/repo', engines: ['codex'], maxAgents: 8 })
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'mac', harnessId: randomUUID(), name: 'Lead', configuration: config, lead: true })).result.agentId)
  const upload = async (bytes: Buffer, name = 'Voice message.wav', mime = 'audio/wav', user = owner) =>
    (await store.upload(user, tab, 'lead', { name, mime, body: Readable.from([bytes]) })).attachment
  return { store, tab, execute, lead, upload, voice, files }
}

describe('reading a voice file', () => {
  it('answers its length, waveform and that it was transcribed, and transcribes it once', async () => {
    const f = await swarm()
    const file = await f.upload(wav(81))
    const first = await f.store.readVoice(owner, f.tab, file.id, 'en')
    expect(first.voice).toMatchObject({ durationMs: 81_000, transcribed: true })
    expect(first.voice.waveform).toHaveLength(48)
    expect(first.voice).not.toHaveProperty('transcript')
    expect(await f.store.readVoice(owner, f.tab, file.id, 'en')).toEqual(first)
    expect(f.voice.calls).toMatchObject({ transcribe: 1, reserved: [`voice:${file.id}`], committed: [`voice:${file.id}`] })
  })

  it('lets one of two calls at once transcribe, and the other wait', async () => {
    const f = await swarm()
    let finish!: (words: string) => void
    f.voice.answer = () => new Promise(resolve => { finish = resolve })
    const file = await f.upload(wav(2))
    const first = f.store.readVoice(owner, f.tab, file.id, 'en')
    await vi.waitFor(() => expect(f.voice.calls.transcribe).toBe(1))
    await expect(f.store.readVoice(owner, f.tab, file.id, 'en')).rejects.toMatchObject({ code: 'VOICE_TRANSCRIBING', statusCode: 409 })
    finish('Hello.')
    expect((await first).voice.transcribed).toBe(true)
    expect(f.voice.calls.transcribe).toBe(1)
  })

  it('takes over a claim left for over two minutes', async () => {
    let at = Date.now()
    const f = await swarm(fakeVoice(), () => at)
    const file = await f.upload(wav(2))
    await db.superTabAttachment.update({ where: { id: file.id }, data: { voiceSince: new Date(at - 60_000) } })
    await expect(f.store.readVoice(owner, f.tab, file.id, 'en')).rejects.toMatchObject({ code: 'VOICE_TRANSCRIBING' })
    at += 61_000 + 60_000
    expect((await f.store.readVoice(owner, f.tab, file.id, 'en')).voice.transcribed).toBe(true)
  })

  it('refuses another actor\'s file, a sent one, an agent caller, a file that is not WAV and a clip over 10:05', async () => {
    const f = await swarm()
    await f.execute({ type: 'member.add', email: peer.email, role: 'member' }).catch(() => undefined)
    const file = await f.upload(wav(2))
    await expect(f.store.readVoice(peer, f.tab, file.id, 'en')).rejects.toMatchObject({ code: expect.stringMatching(/ATTACHMENT_UNAVAILABLE|NOT_FOUND|FORBIDDEN/) })
    await expect(f.store.readVoice(owner, f.tab, file.id, 'en', f.lead)).rejects.toMatchObject({ code: 'VOICE_PEOPLE_ONLY' })
    const text = await f.upload(Buffer.from('hello, this is not audio at all, only some text that is long enough'), 'notes.wav')
    await expect(f.store.readVoice(owner, f.tab, text.id, 'en')).rejects.toMatchObject({ code: 'UNSUPPORTED_AUDIO', statusCode: 415 })
    const png = await f.upload(wav(2), 'shot.png', 'image/png')
    await expect(f.store.readVoice(owner, f.tab, png.id, 'en')).rejects.toMatchObject({ code: 'UNSUPPORTED_AUDIO' })
    await f.execute({ type: 'message.send', conversationId: 'lead', text: '', replyTo: null, recipientIds: [], attachmentIds: [file.id] })
    await expect(f.store.readVoice(owner, f.tab, file.id, 'en')).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' })
    // Over the form's 10 MB: a long clip is stored straight in the bucket in production; here, as if it were.
    const long = await f.upload(wav(1))
    const row = await db.superTabAttachment.findUniqueOrThrow({ where: { id: long.id } })
    const big = wav(606)
    f.files.objects.set(row.objectKey, { ...f.files.objects.get(row.objectKey)!, bytes: big })
    await db.superTabAttachment.update({ where: { id: long.id }, data: { size: big.length } })
    await expect(f.store.readVoice(owner, f.tab, long.id, 'en')).rejects.toMatchObject({ code: 'VOICE_TOO_LONG', statusCode: 413 })
    expect(f.voice.calls.transcribe).toBe(0)
  })

  it('sends without words past the daily voice limit or when transcription fails, once, and logs no words', async () => {
    const voice = fakeVoice('my secret plan')
    const f = await swarm(voice)
    const logged: string[] = []
    const spies = (['info', 'warn', 'error'] as const).map(level => vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => { logged.push(JSON.stringify(args)); return logger }))
    voice.quota = 'limit'
    const limited = await f.upload(wav(3))
    expect((await f.store.readVoice(owner, f.tab, limited.id, 'en')).voice).toMatchObject({ durationMs: 3000, transcribed: false, failure: 'limit' })
    expect(voice.calls.transcribe).toBe(0)
    voice.quota = 'ok'
    voice.answer = async () => { throw new Error('Deepgram HTTP 503') }
    const failed = await f.upload(wav(3))
    expect((await f.store.readVoice(owner, f.tab, failed.id, 'en')).voice).toMatchObject({ transcribed: false, failure: 'failed' })
    expect(voice.calls.released).toEqual([`voice:${failed.id}`])
    voice.answer = async () => 'my secret plan'
    expect((await f.store.readVoice(owner, f.tab, failed.id, 'en')).voice).toMatchObject({ failure: 'failed' })
    const spoken = await f.upload(wav(3))
    await f.store.readVoice(owner, f.tab, spoken.id, 'en')
    spies.forEach(spy => spy.mockRestore())
    expect(logged.some(line => line.includes('super-tab voice'))).toBe(true)
    expect(logged.join('\n')).not.toContain('my secret plan')
  })
})
