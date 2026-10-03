import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tailFile } from './sessions.js'

const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function file(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'transcript-tail-')); directories.push(dir)
  const path = join(dir, 'session.jsonl'); await writeFile(path, content); return path
}
describe('tailFile', () => {
  it('returns the same full history across many stream chunks and UTF-8 boundaries', async () => {
    const lines = Array.from({length: 5000}, (_, i) => JSON.stringify({ i, text: 'é💡' + 'a'.repeat(300) }))
    const path = await file(lines.join('\n\n') + '\n')
    expect(await tailFile(path, Infinity)).toEqual(lines)
    expect(await tailFile(path, 25)).toEqual(lines.slice(-25))
  })
  it('counts nonempty lines and handles an unfinished last line', async () => {
    const path = await file('first\n' + '\n'.repeat(100000) + 'second\n \nthird')
    expect(await tailFile(path, 2)).toEqual(['second', 'third'])
    expect(await tailFile(path, 3)).toEqual(['first', 'second', 'third'])
  })
  it('keeps a long JSON record whole when it crosses chunk boundaries', async () => {
    const line = JSON.stringify({ text: '界'.repeat(50000) })
    const path = await file('old\n' + line + '\nnew\n')
    expect(await tailFile(path, 2)).toEqual([line, 'new'])
  })
  it('handles missing, empty, and zero-line requests', async () => {
    const path = await file('')
    expect(await tailFile(path, Infinity)).toEqual([])
    expect(await tailFile(path, 10)).toEqual([])
    expect(await tailFile(path, 0)).toEqual([])
    expect(await tailFile(path + '.missing', Infinity)).toEqual([])
    expect(await tailFile(await file('one\ntwo'), 0.5)).toEqual([])
  })
})
