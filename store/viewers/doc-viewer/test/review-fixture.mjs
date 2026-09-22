import { createHash, randomUUID } from 'node:crypto'

// Protocol fixture only. Native PDF parsing and geometry are exercised with Typst in review-browser.mjs.
export const pdf = Buffer.from(
  '%PDF-1.7\n' + '% A bounded review upload fixture.\n'.repeat(5) + '%%EOF\n'
)
export function metadata() {
  return {
    spec: 'doc-review/1',
    id: randomUUID(),
    title: 'Lamp review',
    source: {
      path: 'out/field-notes.pdf',
      title: 'Field notes',
      pages: 3,
      sha256: createHash('sha256').update(pdf).digest('hex')
    },
    notes: [
      {
        id: randomUUID(),
        page: 1,
        kind: 'change',
        text: 'Name the brightness used to measure the target.',
        quote: 'A full workday should fit in one charge.',
        rects: [[0.12, 0.6, 0.65, 0.024]]
      }
    ]
  }
}
export function pack(value = metadata(), bytes = pdf) {
  const head = Buffer.from(JSON.stringify(value)),
    size = Buffer.alloc(4)
  size.writeUInt32LE(head.length)
  return Buffer.concat([size, head, bytes])
}
