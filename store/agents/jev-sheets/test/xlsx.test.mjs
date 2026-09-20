// An Excel file dropped on the pane is read as it is: the first sheet, header row first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readXlsx } from '../viewer/xlsx.mjs'
import { loadSource } from '../viewer/source.mjs'
import { startSheetsViewer } from '../viewer/viewer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---- a tiny zip writer, so the fixture is built here and not checked in as a binary ----------------
const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function zip(files) {
  const locals = [], central = []
  let offset = 0
  for (const [name, text, store] of files) {
    const raw = Buffer.from(text), data = store ? raw : deflateRawSync(raw), nameBuf = Buffer.from(name)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(store ? 0 : 8, 8)
    head.writeUInt32LE(crc32(raw), 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBuf.length, 26)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(store ? 0 : 8, 10)
    cd.writeUInt32LE(crc32(raw), 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42)
    locals.push(head, nameBuf, data); central.push(cd, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, end])
}

const SHARED = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6">
<si><t>Customer</t></si><si><t>Feedback</t></si><si><t>Ana &amp; Co</t></si>
<si><r><t>The checkout </t></r><r><rPr><b/></rPr><t xml:space="preserve">froze twice</t></r><rPh><t>ignored</t></rPh></si>
<si><t>Bo</t></si><si><t>Refund "please" &lt;today&gt;</t></si></sst>`
const SHEET = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Stars</t></is></c><c r="E1" t="inlineStr"><is><t>Paid</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>2</v></c><c r="E2" t="b"><v>1</v></c></row>
<row r="3"></row>
<row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4" t="s"><v>5</v></c><c r="C4" s="3"><v>4.5</v></c><c r="D4"/><c r="E4" t="str"><f>IF(1,"no")</f><v>no</v></c></row>
</sheetData></worksheet>`
const workbook = () => zip([
  ['[Content_Types].xml', '<Types/>', true],
  ['xl/sharedStrings.xml', SHARED],
  ['xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>second sheet, not read</t></is></c></row></sheetData></worksheet>'],
  ['xl/worksheets/sheet1.xml', SHEET],
])

test('readXlsx: shared and inline strings, rich text, entities, numbers, booleans, formulas, gaps', () => {
  assert.deepEqual(readXlsx(workbook()), [
    ['Customer', 'Feedback', 'Stars', '', 'Paid'],
    ['Ana & Co', 'The checkout froze twice', '2', '', 'TRUE'],
    ['Bo', 'Refund "please" <today>', '4.5', '', 'no'],
  ])
  assert.throws(() => readXlsx(Buffer.from('this is not a workbook at all')), /not a zip/)
  assert.throws(() => readXlsx(zip([['hello.txt', 'hi']])), /no worksheet/)
})

test('an Excel file is a source like any other: the prose column is the text, the rest ride along', () => {
  const ws = mkdtempSync(join(tmpdir(), 'jev-sheets-xlsx-'))
  writeFileSync(join(ws, 'feedback.xlsx'), workbook())
  const got = loadSource(ws, 'feedback.xlsx')
  assert.equal(got.error, null)
  assert.deepEqual(got.info, { name: 'feedback.xlsx', textColumn: 'Feedback', total: 2, used: 2 })
  assert.deepEqual(got.rows[0], { text: 'The checkout froze twice', Customer: 'Ana & Co', Stars: 2, Paid: 'TRUE' })
  writeFileSync(join(ws, 'broken.xlsx'), 'nope')
  assert.match(loadSource(ws, 'broken.xlsx').error, /could not be parsed: not a zip file/)
})

test('an Excel file dropped on the pane becomes the sheet', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'jev-sheets-xlsx-'))
  writeFileSync(join(ws, 'sheet.json'), readFileSync(join(HERE, '../template/sheet.json')))
  const viewer = await startSheetsViewer({ workspace: ws, port: 0, autostart: false })
  try {
    const r = await (await fetch(`${viewer.url}/upload?name=${encodeURIComponent('Customer feedback.xlsx')}`, { method: 'POST', body: workbook() })).json()
    assert.deepEqual(r, { ok: true, file: 'Customer-feedback.xlsx', rows: 2, total: 2, textColumn: 'Feedback' })
    const s = await (await fetch(`${viewer.url}/state`)).json()
    assert.equal(s.own, true)
    assert.deepEqual(s.rows.map((x) => x.text), ['The checkout froze twice', 'Refund "please" <today>'])
    assert.equal(s.textLabel, 'Feedback')
  } finally { await viewer.close() }
})
