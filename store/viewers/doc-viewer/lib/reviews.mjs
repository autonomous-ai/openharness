// Immutable document review packets. The PDF is the exact byte sequence held by the reader.
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { writeProjectZip } from './zip.mjs'

export const MAX_PDF = 30 * 1024 * 1024
export const MAX_METADATA = 2 * 1024 * 1024
export const MAX_UPLOAD = MAX_PDF + MAX_METADATA + 4
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const bad = (message) => {
  throw Object.assign(new Error(message), { status: 400 })
}
const text = (value, max, label, empty = false) => {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim())
  )
    bad(`Provide ${label} of at most ${max} characters`)
  return value
}

export function unpackReview(body) {
  if (!Buffer.isBuffer(body) || body.length < 68 || body.length > MAX_UPLOAD)
    bad('The review upload is incomplete or too large')
  const length = body.readUInt32LE(0)
  if (length < 2 || length > MAX_METADATA || length + 4 >= body.length)
    bad('The review metadata is incomplete or too large')
  let input
  try {
    input = JSON.parse(body.subarray(4, length + 4))
  } catch {
    bad('The review metadata is not JSON')
  }
  if (
    !input ||
    input.spec !== 'doc-review/1' ||
    typeof input.id !== 'string' ||
    !UUID.test(input.id)
  )
    bad('Provide a document review identifier')
  const title = text(input.title, 120, 'a review title')
  const source = input.source
  if (
    !source ||
    !Number.isInteger(source.pages) ||
    source.pages < 1 ||
    source.pages > 500
  )
    bad('Reviews support 1–500 pages')
  const path = text(source.path, 512, 'a workspace PDF path')
  if (
    path.startsWith('/') ||
    /[\\\u0000-\u001f]/.test(path) ||
    path.split('/').some((part) => part === '..' || part === '.' || !part) ||
    !path.toLowerCase().endsWith('.pdf')
  )
    bad('Use a relative workspace PDF path')
  const pdf = body.subarray(length + 4)
  if (
    pdf.length > MAX_PDF ||
    !pdf.subarray(0, 1024).includes(Buffer.from('%PDF-')) ||
    !pdf.subarray(-2048).includes(Buffer.from('%%EOF'))
  )
    bad('Provide a complete PDF of at most 30 MB')
  const pdfSha = sha(pdf)
  if (source.sha256 !== pdfSha)
    bad('The PDF bytes do not match the reviewed draft')
  if (!Array.isArray(input.notes) || input.notes.length > 100)
    bad('A review supports at most 100 notes')
  const ids = new Set()
  const notes = input.notes.map((note) => {
    if (
      !note ||
      typeof note.id !== 'string' ||
      !UUID.test(note.id) ||
      ids.has(note.id)
    )
      bad('Each note needs a unique identifier')
    ids.add(note.id)
    if (
      !Number.isInteger(note.page) ||
      note.page < 1 ||
      note.page > source.pages
    )
      bad('The note refers to an unavailable page')
    if (!['change', 'keep', 'question'].includes(note.kind))
      bad('Choose Change, Keep or Question for each note')
    if (!Array.isArray(note.rects) || note.rects.length > 80)
      bad('The note has too many highlight rectangles')
    const rects = note.rects.map((rect) => {
      if (
        !Array.isArray(rect) ||
        rect.length !== 4 ||
        !rect.every(Number.isFinite)
      )
        bad('A note has invalid page coordinates')
      const [x, y, width, height] = rect
      if (
        x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > 1.000001 ||
        y + height > 1.000001
      )
        bad('A highlight must stay inside its page')
      return rect
    })
    return {
      id: note.id,
      page: note.page,
      kind: note.kind,
      text: text(note.text, 2000, 'a note'),
      quote: text(note.quote, 2000, 'selected text', true),
      rects
    }
  })
  return {
    pdf,
    review: {
      spec: 'doc-review/1',
      id: input.id,
      title: title.trim(),
      source: {
        path,
        title: text(source.title || path, 200, 'a document title'),
        pages: source.pages,
        sha256: pdfSha,
        bytes: pdf.length
      },
      notes
    },
    contentSha256: sha(body)
  }
}

function shelf(workspace, create = false) {
  let path = realpathSync(workspace)
  for (const part of ['.harness', 'doc-reviews']) {
    path = join(path, part)
    if (!existsSync(path) && create) mkdirSync(path, { mode: 0o700 })
    if (!existsSync(path)) return null
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Document reviews require a real workspace directory')
  }
  return path
}

function reviewMarkdown(review) {
  const lines = [
    `# ${review.title}`,
    '',
    `Reviewed document: ${review.source.path}`,
    `PDF SHA-256: ${review.source.sha256}`,
    `Pages: ${review.source.pages}`,
    '',
    'Feedback is anchored to reference.pdf in this packet. Page numbers and quoted text describe that exact draft. Read the notes as review feedback, then edit the original document source in the workspace. Preserve this packet.',
    ''
  ]
  review.notes.forEach((note, i) => {
    lines.push(
      `## ${i + 1}. ${note.kind[0].toUpperCase() + note.kind.slice(1)} · page ${note.page}`,
      '',
      `Note ID: ${note.id}`,
      ''
    )
    if (note.quote)
      lines.push(...note.quote.split('\n').map((line) => '> ' + line), '')
    lines.push(note.text, '')
  })
  return lines.join('\n') + '\n'
}

export function createReviewService(workspace) {
  function file(id, name) {
    if (
      !UUID.test(id) ||
      !['review.json', 'reference.pdf', 'review.md', 'review.zip'].includes(
        name
      )
    )
      return null
    const root = shelf(workspace)
    if (!root) return null
    const folder = join(root, id)
    try {
      if (lstatSync(folder).isSymbolicLink()) return null
      const path = join(folder, name),
        stat = lstatSync(path)
      return stat.isFile() && !stat.isSymbolicLink() ? path : null
    } catch {
      return null
    }
  }
  function list() {
    let root
    try {
      root = shelf(workspace)
    } catch {
      return []
    }
    if (!root) return []
    return readdirSync(root)
      .filter((id) => UUID.test(id))
      .flatMap((id) => {
        try {
          const path = file(id, 'review.json')
          if (!path || lstatSync(path).size > MAX_METADATA) return []
          const review = JSON.parse(readFileSync(path, 'utf8'))
          if (
            review.spec !== 'doc-review/1' ||
            !Array.isArray(review.notes) ||
            typeof review.title !== 'string'
          )
            return []
          return [
            {
              id,
              title: review.title,
              path: review.source.path,
              notes: review.notes.length,
              savedAt: review.savedAt
            }
          ]
        } catch {
          return []
        }
      })
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
      .slice(0, 100)
  }
  function keep(body) {
    const { review, pdf, contentSha256 } = unpackReview(body)
    const root = shelf(workspace, true),
      destination = join(root, review.id)
    if (existsSync(destination)) {
      const existing = file(review.id, 'review.json')
      if (
        !existing ||
        JSON.parse(readFileSync(existing)).contentSha256 !== contentSha256
      )
        throw Object.assign(
          new Error(
            'This review identifier already belongs to a different saved packet'
          ),
          { status: 409 }
        )
      return {
        id: review.id,
        path: `.harness/doc-reviews/${review.id}`,
        repeated: true
      }
    }
    const scratch = mkdtempSync(join(root, '.saving-' + review.id + '-'))
    try {
      const stored = {
        ...review,
        savedAt: new Date().toISOString(),
        contentSha256,
        coordinates:
          'Rectangles are [left, top, width, height] fractions of the displayed PDF page in its intrinsic rotation.'
      }
      writeFileSync(join(scratch, 'reference.pdf'), pdf)
      writeFileSync(
        join(scratch, 'review.json'),
        JSON.stringify(stored, null, 2) + '\n'
      )
      writeFileSync(join(scratch, 'review.md'), reviewMarkdown(stored))
      writeFileSync(
        join(scratch, 'README.md'),
        'This packet preserves the exact reviewed PDF and the reviewer’s notes. Open reference.pdf and read review.md, or reopen the packet in Harness Doc Viewer. review.json includes page-relative highlight rectangles and the PDF SHA-256. Notes are separate from the original PDF; they are not embedded PDF annotations. The editable document source stays in the original workspace.\n'
      )
      writeProjectZip(scratch, join(scratch, 'review.zip'))
      renameSync(scratch, destination)
      return {
        id: review.id,
        path: `.harness/doc-reviews/${review.id}`,
        repeated: false
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  return { file, list, keep }
}
