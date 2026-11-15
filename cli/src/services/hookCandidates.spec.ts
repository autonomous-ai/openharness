import { expect, it } from 'vitest'
import { createHookCandidates } from './hookCandidates.js'

const input = { engine: 'claude' as const, port: 1234, environment: { HOME: '/fixture' },
  files: [{ file: '/fixture/settings.json', directory: '/fixture', content: '{}', mode: 0o600 }] }

it('renders only captured files in memory and retains immutable source observations', async () => {
  const collector = createHookCandidates(input, () => true)
  const original = collector.files.inspect(input.files[0].file)
  await collector.files.run([input.files[0].file], async attempt => {
    await original.replace('{"hooks":{}}', attempt)
    expect(() => original.verify()).toThrow('candidate changed')
    collector.files.inspect(input.files[0].file).verify()
  })
  expect(input.files[0].content).toBe('{}')
  expect(collector.candidate()).toEqual({ version: 1, files: [{ index: 0, content: '{"hooks":{}}' }] })
  expect(() => collector.files.inspect('/another-profile/settings.json')).toThrow('not captured')
})

it('cannot render after cancellation or through native filesystem effects', async () => {
  let current = true
  const collector = createHookCandidates(input, () => current)
  await expect(collector.files.run([input.files[0].file], async attempt => attempt.flush(3))).rejects.toThrow('native descriptor')
  await expect(collector.files.run([input.files[0].file], async attempt => {
    collector.files.directory('/another-profile', 0o700, attempt)
  })).rejects.toThrow('not captured')
  current = false
  expect(() => collector.candidate()).toThrow('owner changed')
  await expect(collector.files.run([input.files[0].file], async () => true)).rejects.toThrow('owner changed')
})

it('keeps read-only inputs unchanged and bounds generated content before accepting it', async () => {
  const collector = createHookCandidates({ ...input, files: [{ ...input.files[0], mode: 0o400 }] }, () => true)
  await expect(collector.files.run([input.files[0].file], async attempt => {
    await collector.files.inspect(input.files[0].file).replace('changed', attempt)
  })).rejects.toThrow('read-only')
  const writable = createHookCandidates(input, () => true)
  await expect(writable.files.run([input.files[0].file], async attempt => {
    await writable.files.inspect(input.files[0].file).replace('x'.repeat(1024 * 1024 + 1), attempt)
  })).rejects.toThrow('size limit')
  expect(collector.candidate()!.files[0].content).toBe('{}')
})

it('refuses oversized captured input before a renderer can observe it', () => {
  expect(() => createHookCandidates({ ...input, files: [{ ...input.files[0], content: 'x'.repeat(1024 * 1024 + 1) }] }, () => true))
    .toThrow('inputs exceed their limits')
})

it('preserves exclusive creation and refuses removal through an aliased occupied destination', async () => {
  const file = input.files[0].file
  const occupied = createHookCandidates(input, () => true)
  await expect(occupied.files.run([file], attempt => occupied.files.inspect(file).replace('new', attempt, true)))
    .rejects.toThrow('claim is occupied')
  const aliased = createHookCandidates({ ...input, files: [{ ...input.files[0], alias: true }] }, () => true)
  await expect(aliased.files.run([file], attempt => aliased.files.inspect(file).remove(attempt)))
    .rejects.toThrow('plugin entry is an alias')
  expect(aliased.candidate()!.files[0].content).toBe('{}')
  await occupied.files.run([file], async attempt => {
    await occupied.files.inspect(file).remove(attempt)
    expect(occupied.files.inspect(file).stamp).toBeNull()
    await occupied.files.inspect(file).replace('new', attempt, true)
  })
  expect(occupied.candidate()!.files[0].content).toBe('new')
})

it('uses the requested mode for a missing artifact and keeps an unchanged observation valid', async () => {
  const file = input.files[0].file
  const collector = createHookCandidates({ ...input, files: [{ file, directory: '/fixture', content: null }] }, () => true)
  expect(collector.files.inspect(file, 0o700).mode).toBe(0o700)
  expect(collector.files.inspect(file).mode).toBe(0o666)
  await collector.files.run([file], async attempt => {
    await collector.files.write(file, 'source', 0o700, attempt)
    const unchanged = collector.files.inspect(file)
    await unchanged.replace('source', attempt)
    unchanged.verify()
  })
  expect(collector.candidate()!.files[0].content).toBe('source')
})

it('rechecks the rendering owner after work and rejects observations outside the captured set', async () => {
  const file = input.files[0].file, collector = createHookCandidates(input, () => true)
  let current = true
  await expect(collector.files.run([file], async () => { current = false }, { current: () => current }))
    .rejects.toThrow('owner changed')
  await expect(collector.files.run([file], async attempt => attempt.observe('/another-profile', () => {})))
    .rejects.toThrow('not captured')
})

it('accepts only declared directory paths with their exact requested mode', async () => {
  const file = input.files[0].file
  const collector = createHookCandidates({ ...input, directories: [{ path: '/fixture/sessions', mode: 0o700 }] }, () => true)
  await collector.files.run([file], async attempt => {
    collector.files.directory('/fixture/sessions', 0o700, attempt)
    expect(() => collector.files.directory('/fixture/sessions', 0o755, attempt)).toThrow('not captured')
    expect(() => collector.files.directory('/another-profile', 0o700, attempt)).toThrow('not captured')
  })
  expect(collector.candidate()!.files[0].content).toBe('{}')
})
