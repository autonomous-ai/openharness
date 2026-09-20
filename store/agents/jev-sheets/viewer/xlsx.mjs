// xlsx.mjs — read the first sheet of an Excel workbook into rows of strings. No dependencies.
//
// An .xlsx file is a zip of XML parts. This reads just enough of both: the zip's central directory,
// `xl/sharedStrings.xml`, and the first worksheet. Formulas give their last saved value. Dates come
// through as Excel's day numbers unless the cell was saved as text. Limits keep a hostile file
// from eating memory.
import { inflateRawSync } from 'node:zlib'

const LIMITS = { part: 256 * 1024 * 1024, cells: 2_000_000 }

/** name -> { method, start, size, rawSize } for every file in the zip. */
function directory(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('not a zip file')
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged zip directory')
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), rawSize = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    out.set(name, { method, local, size, rawSize })
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function part(buf, dir, name) {
  const e = dir.get(name)
  if (!e) return null
  if (e.rawSize > LIMITS.part) throw new Error(`${name} is too large`)
  if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error('damaged zip entry')
  const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28)
  const data = buf.subarray(start, start + e.size)
  if (e.method === 0) return data.toString('utf8')
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: LIMITS.part }).toString('utf8')
  throw new Error(`${name} uses a zip method this reader does not know`)
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unxml = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e]))
  .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
/** All <t> text inside a fragment, skipping phonetic guides. */
const texts = (xml) => { let out = ''; for (const m of xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += unxml(m[1]); return out }
/** "BC12" -> 54 (zero-based column). */
function columnOf(ref) { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64) } return n - 1 }

/**
 * @param {Buffer} buf  the bytes of an .xlsx file
 * @returns {string[][]} the first sheet, one list of cell strings per row, blank rows dropped
 */
export function readXlsx(buf) {
  const dir = directory(buf)
  const shared = []
  const sst = part(buf, dir, 'xl/sharedStrings.xml')
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? texts(m[1]) : '')
  // The first sheet: the lowest-numbered worksheet part.
  const sheets = [...dir.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]))
  if (!sheets.length) throw new Error('the workbook has no worksheet')
  const xml = part(buf, dir, sheets[0])
  const rows = []
  let cells = 0
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = []
    let next = 0
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (++cells > LIMITS.cells) throw new Error('the sheet has too many cells')
      const attrs = cm[1], body = cm[2] ?? ''
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1]
      const col = ref ? columnOf(ref) : next
      next = col + 1
      const type = attrs.match(/\bt="(\w+)"/)?.[1]
      const v = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1]
      let value = ''
      if (type === 's') value = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') value = texts(body)
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE'
      else if (v != null) value = unxml(v)
      if (col >= 0 && col < 4096) row[col] = value
    }
    const filled = Array.from(row, (x) => x ?? '')
    if (filled.some((x) => x.trim() !== '')) rows.push(filled)
  }
  return rows
}
