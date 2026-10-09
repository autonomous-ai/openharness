import { expect, it } from 'vitest'
import { externalEvidence, externalReadFailed } from './evidence.js'

it('keeps display fallbacks but refuses swallowed errors for admission, independently per async read', async () => {
  externalReadFailed(new Error('display fallback'))
  const [healthy, broken] = await Promise.all([
    externalEvidence(async () => { await Promise.resolve(); return ['session'] }),
    externalEvidence(async () => { await Promise.resolve(); externalReadFailed(new Error('permission denied'), 'owner record'); return [] }),
  ])
  expect(healthy).toEqual({ ok: true, value: ['session'] })
  expect(broken).toEqual({ ok: false, detail: "The conversation's owner record could not be verified." })
  expect(await externalEvidence(async () => { throw new Error('unavailable') })).toMatchObject({ ok: false })
})

it('treats absent optional stores as empty but missing expected owner records as unknown', async () => {
  const read = async () => { externalReadFailed({ code: 'ENOENT' }); return false }
  expect(await externalEvidence(read)).toEqual({ ok: true, value: false })
  expect(await externalEvidence(read, true)).toMatchObject({ ok: false })
})
