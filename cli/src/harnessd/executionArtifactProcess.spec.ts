import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fingerprint } from './bundleFingerprint.js'
import { createArtifactPreparation, embeddedPreparer, PREPARATION_CODE_BYTES, PREPARATION_TIMEOUT_MS } from './executionArtifactProcess.js'
import { prepareArtifact, preparationRequest, PREPARATION_DATA_BYTES, type PreparationRequest } from './executionArtifactChild.js'
import { adoptExecutionArtifact, type ArtifactMetadata } from './executionArtifacts.js'
import * as artifactModule from './executionArtifacts.js'
import type { CaptureStart } from './childCapture.js'

// @ts-expect-error — the build writer has no declaration file.
const { leanBlock } = await import('../../scripts/lib/leanBlock.mjs') as { leanBlock(files: Record<string, string>): string }

describe('owned artifact preparation', () => {
  let root: string, source: string, directory: string, expected: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'preparer-owner-'))
    source = join(root, 'cli.mjs'); directory = join(root, 'artifacts')
    writeFileSync(source, '// inert full CLI\n' + leanBlock({ 'harnessd.mjs': '// service', 'harnessd-core.mjs': '// core' }))
    expected = fingerprint(source)!
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
  const request = (): PreparationRequest => ({ originalScript: source, directory, expected, parentPid: process.pid })
  const rig = (keepMasterEntry?: string) => {
    let answer: object, sent = ''
    const child = Object.assign(new EventEmitter(), {
      pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
      stdin: Object.assign(new EventEmitter(), { end: (input: string) => {
        sent = input
        const json = input.slice('const __HARNESSD_PREPARATION_REQUEST__ = '.length, input.indexOf(';\n'))
        answer = prepareArtifact(JSON.parse(json), process.pid)
      } }),
    })
    const start = vi.fn<CaptureStart>(() => child as unknown as ChildProcess)
    const owner = createArtifactPreparation({ directory, node: process.execPath, code: '// trusted fixture literal', start, keepMasterEntry })
    const close = (response: unknown = answer) => {
      child.stdout.emit('data', Buffer.from(typeof response === 'string' ? response : JSON.stringify(response)))
      child.emit('close', 0, null)
    }
    return { owner, start, child, close, answer: () => answer as { ok: true; artifact: ArtifactMetadata }, sent: () => sent }
  }

  it('admits metadata only after actual close and keeps its claim until release', async () => {
    const fixture = rig(), running = fixture.owner.prepare(source, expected)
    const settled = vi.fn(); void running.result.then(settled)
    expect(settled).not.toHaveBeenCalled()
    expect(fixture.sent()).toContain('// trusted fixture literal')
    const folder = join(directory, fixture.answer().artifact.folder), claim = join(folder, `.claim-${process.pid}`)
    expect(existsSync(claim)).toBe(true)
    running.cancel()
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(settled).not.toHaveBeenCalled()
    fixture.close()
    const image = await running.result
    expect(image.originalScript).toBe(source)
    expect(fingerprint(image.fullScript)).toBe(expected)
    expect(image.leanCoreScript).toBe(join(folder, 'harnessd-core.mjs'))
    expect(() => fixture.owner.prepare(source, expected)).toThrow('worker_artifact_in_use')
    image.release(); image.release()
    expect(existsSync(claim)).toBe(false)
  })

  it('does not let an old repeated release drop ownership of a newer preparation', async () => {
    const fixture = rig()
    const first = fixture.owner.prepare(source, expected); fixture.close(); const previous = await first.result
    previous.release()
    const next = fixture.owner.prepare(source, expected)
    previous.release()
    expect(() => fixture.owner.prepare(source, expected)).toThrow('worker_artifact_in_use')
    fixture.close(); (await next.result).release()
  })

  it('lets a slow cohort publication finish beyond the lightweight probe deadline', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fixture = rig(), running = fixture.owner.prepare(source, expected)
    const result = running.result.then(image => ({ image }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(16_000)
    const killed = fixture.child.kill.mock.calls.length
    fixture.close()
    const outcome = await result
    if ('image' in outcome) outcome.image.release()
    expect(killed).toBe(0)
    expect(outcome).toHaveProperty('image')
    expect(warn).toHaveBeenCalledWith('[harnessd] worker_artifact_preparation_slow · ms=16000')
  })

  it('terminates at its own preparation deadline and keeps custody until actual close', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fixture = rig(), running = fixture.owner.prepare(source, expected), settled = vi.fn()
    const result = running.result.then(settled, error => { settled(); return error })
    await vi.advanceTimersByTimeAsync(PREPARATION_TIMEOUT_MS - 1)
    expect(fixture.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(settled).not.toHaveBeenCalled()
    fixture.child.emit('close', null, 'SIGKILL')
    expect(await result).toMatchObject({ message: 'worker_artifact_cleanup_unsettled' })
    expect(warn).toHaveBeenCalledWith('[harnessd] worker_artifact_preparation_timed_out')
    expect(() => fixture.owner.prepare(source, expected)).toThrow('worker_artifact_cleanup_unsettled')
  })

  it('preserves the original master claim and forwards only the minimal OS environment', async () => {
    const folder = join(directory, '0'.repeat(16)), original = join(folder, 'harnessd.mjs')
    mkdirSync(folder, { recursive: true }); writeFileSync(original, '// original master')
    const claim = join(folder, `.claim-${process.pid}`); writeFileSync(claim, '')
    vi.stubEnv('SystemRoot', join(root, 'os')); vi.stubEnv('HARNESSD_SERVICE_TOKEN', 'fixture-private-token')
    const fixture = rig(original), running = fixture.owner.prepare(source, expected)
    expect(fixture.start.mock.calls[0][2]).toMatchObject({ SystemRoot: join(root, 'os') })
    expect(fixture.start.mock.calls[0][2]).not.toHaveProperty('HARNESSD_SERVICE_TOKEN')
    fixture.close(); (await running.result).release()
    expect(existsSync(claim)).toBe(true)
  })

  it.each(['invalid-json', 'oversized', 'unknown-code', 'unexpected-field', 'null', 'array'])('latches one possibly published attempt after %s', async kind => {
    const fixture = rig(), running = fixture.owner.prepare(source, expected)
    const folder = join(directory, fixture.answer().artifact.folder)
    const reply = kind === 'invalid-json' ? '{' : kind === 'oversized' ? ' '.repeat(4097)
      : kind === 'unknown-code' ? { ok: false, code: 'private arbitrary detail' }
      : kind === 'unexpected-field' ? { ...fixture.answer(), path: '/outside' } : kind === 'null' ? null : []
    fixture.close(reply)
    await expect(running.result).rejects.toThrow('worker_artifact_cleanup_unsettled')
    expect(() => fixture.owner.prepare(source, expected)).toThrow('worker_artifact_cleanup_unsettled')
    expect(fixture.start).toHaveBeenCalledTimes(1)
    expect(existsSync(join(folder, `.claim-${process.pid}`))).toBe(true)
  })

  it('latches a lost reply and preserves the parent claim after actual termination', async () => {
    const fixture = rig(), running = fixture.owner.prepare(source, expected)
    running.cancel(); fixture.child.emit('close', null, 'SIGKILL')
    await expect(running.result).rejects.toThrow('worker_artifact_cleanup_unsettled')
    expect(() => fixture.owner.prepare(source, expected)).toThrow('worker_artifact_cleanup_unsettled')
    expect(readdirSync(directory)).toHaveLength(1)
  })

  it.each(['worker_artifact_storage_unavailable', 'worker_artifact_source_changed', 'worker_artifact_source_close_unsettled', 'worker_artifact_cleanup_unsettled'])('preserves the fixed failure %s and its retry rule', async code => {
    const fixture = rig(), running = fixture.owner.prepare(source, expected)
    fixture.close({ ok: false, code })
    await expect(running.result).rejects.toThrow(code)
    if (code.endsWith('_unsettled')) expect(() => fixture.owner.prepare(source, expected)).toThrow('worker_artifact_cleanup_unsettled')
    else {
      const next = fixture.owner.prepare(source, expected); fixture.close(); (await next.result).release()
    }
  })

  it('has no publication uncertainty when spawn fails before a PID exists', async () => {
    const fixture = rig()
    fixture.start.mockImplementationOnce(() => { throw new Error('UNKNOWN') })
    const failed = fixture.owner.prepare(source, expected)
    await expect(failed.result).rejects.toThrow('worker_artifact_source_unavailable')
    expect(existsSync(directory)).toBe(false)
    const next = fixture.owner.prepare(source, expected); fixture.close(); (await next.result).release()
  })

  it('bounds trusted code and fixed-shape data before spawn; source development has no implicit preparer', () => {
    expect(embeddedPreparer()).toBeUndefined()
    vi.stubGlobal('__WORKER_ARTIFACT_PREPARER__', 'embedded')
    expect(embeddedPreparer()).toBe('embedded')
    vi.unstubAllGlobals()
    const start = vi.fn()
    for (const code of [undefined, '', 'x'.repeat(PREPARATION_CODE_BYTES + 1)]) {
      const owner = createArtifactPreparation({ directory, node: process.execPath, code, start })
      expect(() => owner.prepare(source, expected)).toThrow('worker_artifact_request_refused')
    }
    const owner = createArtifactPreparation({ directory, node: process.execPath, code: 'trusted', start })
    expect(() => owner.prepare(source, 'wrong')).toThrow('worker_artifact_request_refused')
    expect(start).not.toHaveBeenCalled()
  })

  it('requires its actual parent and bounded fixed-shape request', () => {
    expect(preparationRequest(request(), process.pid)).toBe(true)
    for (const input of [null, [], { ...request(), unexpected: true }, { ...request(), parentPid: 0 },
      { ...request(), expected: 'bad' }, { ...request(), directory: 'relative' }, { ...request(), originalScript: '/nul\0path' },
      { ...request(), keepMasterEntry: 3 }, { ...request(), originalScript: `/${'x'.repeat(PREPARATION_DATA_BYTES)}` }]) {
      expect(preparationRequest(input, process.pid)).toBe(false)
      expect(prepareArtifact(input, process.pid)).toEqual({ ok: false, code: 'worker_artifact_request_refused' })
    }
    expect(prepareArtifact(request())).toEqual({ ok: false, code: 'worker_artifact_request_refused' })
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    expect(preparationRequest(cycle, process.pid)).toBe(false)
  })

  it('serializes a cleaned-up disk failure as a fixed retryable preparation result', () => {
    vi.spyOn(artifactModule, 'createExecutionArtifacts').mockImplementationOnce(() => {
      throw new Error('worker_artifact_storage_unavailable')
    })
    expect(prepareArtifact(request(), process.pid)).toEqual({ ok: false, code: 'worker_artifact_storage_unavailable' })
  })

  it('reports a real source change and sanitizes unexpected preparer failures', () => {
    writeFileSync(source, '// changed before the preparer opened it')
    expect(prepareArtifact(request(), process.pid)).toEqual({ ok: false, code: 'worker_artifact_source_changed' })
    for (const error of [new Error('private failure detail'), 'private failure detail']) {
      vi.spyOn(artifactModule, 'createExecutionArtifacts').mockImplementationOnce(() => { throw error })
      expect(prepareArtifact(request(), process.pid)).toEqual({ ok: false, code: 'worker_artifact_cleanup_unsettled' })
    }
  })

  it('keeps a verified lean image without a dedicated core entry and releases it idempotently', () => {
    writeFileSync(source, '// older lean format\n' + leanBlock({ 'harnessd.mjs': '// services only' }))
    expected = fingerprint(source)!
    const reply = prepareArtifact(request(), process.pid) as { ok: true; artifact: ArtifactMetadata }
    expect(reply.artifact.lean?.core).toBeUndefined()
    const image = adoptExecutionArtifact(source, expected, reply.artifact, { directory })
    expect(image.leanScript).toBeDefined(); expect(image.leanCoreScript).toBeUndefined()
    image.release(); image.release()
  })

  it.each([false, true])('returns the same legacy/modern-independent immutable payload (lean=%s)', lean => {
    if (!lean) { writeFileSync(source, '// full fallback'); expected = fingerprint(source)! }
    const reply = prepareArtifact(request(), process.pid) as { ok: true; artifact: ArtifactMetadata }
    expect(reply.ok).toBe(true)
    const image = adoptExecutionArtifact(source, expected, reply.artifact, { directory })
    expect(fingerprint(image.fullScript)).toBe(expected)
    expect(!!image.leanCoreScript).toBe(lean)
    image.release()
    expect(existsSync(join(dirname(image.fullScript), `.claim-${process.pid}`))).toBe(false)
  })

  it('prepares lean and full images in the actual bounded stdin child', async () => {
    // @ts-expect-error — the existing build scripts have no declaration files.
    const { workerPreparer } = await import('../../scripts/lib/workerPreparer.mjs') as { workerPreparer(): Promise<string> }
    const code = await workerPreparer()
    expect(Buffer.byteLength(code)).toBeLessThanOrEqual(PREPARATION_CODE_BYTES)
    const owner = createArtifactPreparation({ directory, node: process.execPath, code })
    for (const lean of [true, false]) {
      if (!lean) { writeFileSync(source, '// full-only selected bundle'); expected = fingerprint(source)! }
      const image = await owner.prepare(source, expected).result
      expect(fingerprint(image.fullScript)).toBe(expected)
      expect(Boolean(image.leanCoreScript)).toBe(lean)
      expect(image.originalScript).toBe(source)
      image.release()
      expect(existsSync(join(dirname(image.fullScript), `.claim-${process.pid}`))).toBe(false)
    }
  })

  it.each(['unknown-key', 'wrong-selected', 'bad-folder', 'bad-lean', 'bad-entry', 'bad-core', 'changed-full', 'missing-claim'])('refuses metadata or bytes that cannot prove the claimed image: %s', kind => {
    const reply = prepareArtifact(request(), process.pid) as { ok: true; artifact: ArtifactMetadata }
    const meta = structuredClone(reply.artifact) as ArtifactMetadata & { unknown?: boolean }
    if (kind === 'unknown-key') meta.unknown = true
    if (kind === 'wrong-selected') meta.selected = 'a'.repeat(64)
    if (kind === 'bad-folder') meta.folder = '../elsewhere'
    if (kind === 'bad-lean') meta.lean!.fingerprint = 'bad'
    if (kind === 'bad-entry') meta.lean!.entry = 'a'.repeat(64)
    if (kind === 'bad-core') meta.lean!.core = 'a'.repeat(64)
    const folder = join(directory, reply.artifact.folder)
    if (kind === 'changed-full') writeFileSync(join(folder, 'cohort-cli.mjs'), '// changed')
    if (kind === 'missing-claim') rmSync(join(folder, `.claim-${process.pid}`))
    expect(() => adoptExecutionArtifact(source, expected, meta, { directory })).toThrow('worker_artifact_cleanup_unsettled')
    expect(existsSync(folder)).toBe(true)
  })
})
