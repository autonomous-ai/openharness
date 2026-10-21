import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { attachmentsOf, saveAttachment } from './attachments.js'

const image = { id: 'img1', name: 'a.png', mime: 'image/png', size: 3, parts: 1 }
it('keeps only well-formed image rows within the backend limits', () => {
  expect(attachmentsOf({ attachments: [image, { ...image, id: '../x' }, { ...image, mime: 'image/gif' }, { ...image, mime: 'toString' },
    { ...image, size: 5 * 1024 * 1024 + 1 }, { ...image, parts: 0 }, { ...image, parts: 65 }, 'junk'] })).toEqual([image])
  expect(attachmentsOf({ text: 'no images' })).toEqual([])
  expect(attachmentsOf(null)).toEqual([])
})
it('refuses an image whose parts do not add up to its size', async () => {
  const read = async () => ({ data: Buffer.from([1, 2]).toString('base64') })
  await expect(saveAttachment(read, 'tab', 'agent', image)).rejects.toThrow('incomplete')
  await expect(saveAttachment(async () => ({}), 'tab', 'agent', image)).rejects.toThrow('unreadable')
  const path = await saveAttachment(async () => ({ data: Buffer.from([1, 2, 3]).toString('base64') }), 'tab', 'agent', { ...image, name: 'no extension' })
  expect(path).toMatch(/-no-extension\.png$/)
  expect([...readFileSync(path)]).toEqual([1, 2, 3])
})
