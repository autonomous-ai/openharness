import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

test('the optional artifacts work with their source tree and core service absent', { timeout: 20_000 }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'companion-bundle-'))
  const clients = []
  try {
    const artifacts = join(fixture, 'package')
    await cp(new URL('../dist/', import.meta.url), artifacts, { recursive: true })
    await symlink(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(artifacts, 'node_modules'), 'dir')
    // No source files, CLI entry point, service, sockets or provider credentials in this fixture.
    const { MemoryClient, CodingMemoryRuntime } = await import(pathToFileURL(join(artifacts, 'memory.js')))
    const { CompanionZoo } = await import(pathToFileURL(join(artifacts, 'companion.js')))
    assert.equal(typeof CompanionZoo, 'function')
    await import(pathToFileURL(join(artifacts, 'application.js')))
    const state = join(fixture, 'state')
    await mkdir(state)
    let inspected = 0
    const disabled = new CodingMemoryRuntime({ directory: state,
      context: () => ({ experimental: false, watching: false, profileId: 'fixture' }),
      sessions: () => { inspected++; return [] },
      inference: { target: async () => { throw new Error('disabled model inspected') },
        run: async () => { throw new Error('disabled model called') } },
    })
    disabled.start()
    await disabled.tick()
    await disabled.close()
    assert.equal(inspected, 0)
    assert.deepEqual(await readdir(state), [])

    const open = () => {
      const client = new MemoryClient({ directory: state, profileId: 'fixture' })
      clients.push(client)
      return client
    }
    const first = open()
    await first.request('registerProject', ['project'])
    await first.request('setControls', [{ learn: true, recall: true }])
    const event = { id: 'fixture-source', profileId: 'fixture', projectId: 'project', engine: 'claude',
      sessionId: 'synthetic-session', nativeEventId: 'fixture-source', role: 'user', eligibility: 'coding',
      observedAt: Date.now(), rootIds: ['fixture-source'], text: 'I prefer small coding changes.' }
    await first.request('ingest', [event])
    const access = { profileId: 'fixture', projectIds: ['project'], includeProfile: false }
    const { record } = await first.request('propose', [{
      kind: 'working_preference', facet: 'changes', assertionType: 'stated_preference',
      scope: { profileId: 'fixture', projectId: 'project' }, claim: event.text, rationale: null,
      futureAction: 'Keep coding changes small.', applicability: {}, exceptions: [], retrievalCues: ['coding', 'changes'],
      evidenceClass: 'user_stated', evidence: [{ sourceEventId: event.id, quote: event.text, paths: ['/claim', '/futureAction', '/applicability', '/validity'] }],
      conflictKey: 'change-size', validity: { validFrom: null, validUntil: null, recheckWhen: [] },
    }, access])
    await first.close()
    const second = open()
    assert.equal((await second.request('read', [record.id, access])).claim, event.text)
    const recalled = await second.recall({ query: 'coding changes' }, access, 2_000)
    assert.equal(recalled.items.length, 1)
    assert.equal((await second.recall({ query: 'coding' }, { ...access, profileId: 'other' })).status, 'denied')
    const broken = new MemoryClient({ directory: join(fixture, 'broken'), profileId: 'fixture',
      source: 'throw new Error("synthetic worker failure")' })
    clients.push(broken)
    assert.equal((await broken.recall({ query: 'coding' }, access)).status, 'unavailable')
    assert.equal((await second.recall({ query: 'coding changes' }, access)).items.length, 1)

    const memoryGraph = JSON.parse(await readFile(join(artifacts, 'memory.meta.json'), 'utf8'))
    assert(!Object.keys(memoryGraph.inputs).some(path => path.startsWith('src/companion/') || path.startsWith('src/application/')))
    const companionGraph = JSON.parse(await readFile(join(artifacts, 'companion.meta.json'), 'utf8'))
    assert(!Object.keys(companionGraph.inputs).some(path => /src\/memory\/(runtime|store|client|worker)\.ts$/.test(path)))
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await rm(fixture, { recursive: true, force: true })
  }
})
