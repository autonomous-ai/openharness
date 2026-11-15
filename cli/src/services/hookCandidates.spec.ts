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
