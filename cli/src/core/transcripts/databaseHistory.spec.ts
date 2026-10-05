import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { env } from '../../config/env.js'
import { readDevinMessages } from '../../engines/devin/reader.js'
import { readHermesMessages } from '../../engines/hermes/reader.js'
import { readKiloMessages } from '../../engines/kilo/reader.js'
import { readOpencodeMessages } from '../../engines/opencode/reader.js'
import { hermesDbForSession } from '../../lib/hermesHome.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { databaseHistory } from './databaseHistory.js'

vi.mock('../../engines/opencode/reader.js', () => ({ readOpencodeMessages: vi.fn(async () => ['opencode rows']) }))
vi.mock('../../engines/opencode/normalizer.js', () => ({ opencodeMessagesToEvents: vi.fn((rows: unknown[]) => [{ from: 'opencode', rows }]) }))
vi.mock('../../engines/kilo/reader.js', () => ({ readKiloMessages: vi.fn(async () => ['kilo rows']) }))
vi.mock('../../engines/kilo/normalizer.js', () => ({ kiloMessagesToEvents: vi.fn((rows: unknown[]) => [{ from: 'kilo', rows }]) }))
vi.mock('../../engines/devin/reader.js', () => ({ readDevinMessages: vi.fn(async () => ['devin rows']) }))
vi.mock('../../engines/devin/normalizer.js', () => ({ devinMessagesToEvents: vi.fn((rows: unknown[]) => [{ from: 'devin', rows }]) }))
vi.mock('../../engines/hermes/reader.js', () => ({ readHermesMessages: vi.fn(async () => ['hermes rows']) }))
vi.mock('../../engines/hermes/normalizer.js', () => ({ hermesMessagesToEvents: vi.fn((rows: unknown[]) => [{ from: 'hermes', rows }]) }))
vi.mock('../../lib/hermesHome.js', () => ({ hermesDbForSession: vi.fn(async () => '/profiles/work/state.db') }))

const session = (engine: string) => ({ agentId: 'a1', sessionId: 's1', engine }) as RegisteredSession

describe('reading a conversation its engine keeps in a database', () => {
  it('OpenCode, Kilo and Devin from their own stores, through the replay normalizers', async () => {
    expect(await databaseHistory(session('opencode'))!()).toEqual([{ from: 'opencode', rows: ['opencode rows'] }])
    expect(readOpencodeMessages).toHaveBeenCalledWith(join(env.OPENCODE_DATA_DIR, 'opencode.db'), 's1')
    expect(await databaseHistory(session('kilo'))!()).toEqual([{ from: 'kilo', rows: ['kilo rows'] }])
    expect(readKiloMessages).toHaveBeenCalledWith(join(env.KILO_DATA_DIR, 'kilo.db'), 's1')
    expect(await databaseHistory(session('devin'))!()).toEqual([{ from: 'devin', rows: ['devin rows'] }])
    expect(readDevinMessages).toHaveBeenCalledWith(join(env.DEVIN_HOME, 'sessions.db'), 's1')
  })

  it('Hermes from the profile home its session lives in', async () => {
    const hermes = session('hermes')
    expect(await databaseHistory(hermes)!()).toEqual([{ from: 'hermes', rows: ['hermes rows'] }])
    expect(hermesDbForSession).toHaveBeenCalledWith(hermes)
    expect(readHermesMessages).toHaveBeenCalledWith('/profiles/work/state.db', 's1')
  })

  it('nothing to read for an engine with a transcript file, and nothing read until asked', () => {
    expect(databaseHistory(session('claude'))).toBeUndefined()
    databaseHistory(session('opencode'))
    expect(readOpencodeMessages).not.toHaveBeenCalledTimes(2)
  })
})
