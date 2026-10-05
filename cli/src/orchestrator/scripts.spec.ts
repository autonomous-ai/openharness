import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptHashes } from './scripts.js'

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
describe('script hashes', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scripts-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('hashes the files a command names, literally', async () => {
    mkdirSync(join(dir, 'flow')); writeFileSync(join(dir, 'flow/check.sh'), 'echo hi'); writeFileSync(join(dir, 'local.py'), 'print(1)')
    const hashes = await scriptHashes(`bash "$HARNESS_FLOW_DIR/check.sh" && python3 local.py inputs/x/missing.txt; echo $HOME | tee \${HARNESS_PROJECT_DIR}/nope; sh '\${HARNESS_FLOW_DIR}/check.sh'`, { exec: dir, project: dir, flow: join(dir, 'flow') })
    expect(hashes).toEqual([
      { path: join(dir, 'flow/check.sh'), sha256: sha('echo hi') },
      { path: join(dir, 'local.py'), sha256: sha('print(1)') },
    ])
  })
  it('skips folders, big files and anything past sixteen', async () => {
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `s${i}`), String(i))
    writeFileSync(join(dir, 'big'), Buffer.alloc(8 * 1024 * 1024 + 1))
    const hashes = await scriptHashes(`cat big . ${Array.from({ length: 20 }, (_, i) => `s${i}`).join(' ')}`, { exec: dir, project: dir, flow: dir })
    expect(hashes.map(h => h.path)).toEqual(Array.from({ length: 16 }, (_, i) => join(dir, `s${i}`)))
  })
  it('expands only the whole project and flow variable names', async () => {
    for (const folder of ['p', 'p_BACKUP', 'pX', 'f', 'f_OLD', 'f2']) { mkdirSync(join(dir, folder)); writeFileSync(join(dir, folder, 'x'), folder) }
    const hashes = await scriptHashes('cat $HARNESS_PROJECT_DIR_BACKUP/x $HARNESS_PROJECT_DIRX/x ${HARNESS_FLOW_DIR_OLD}/x $HARNESS_FLOW_DIR2/x $HARNESS_PROJECT_DIR/x ${HARNESS_FLOW_DIR}/x', { exec: join(dir, 'nowhere'), project: join(dir, 'p'), flow: join(dir, 'f') })
    expect(hashes).toEqual([{ path: join(dir, 'p/x'), sha256: sha('p') }, { path: join(dir, 'f/x'), sha256: sha('f') }])
  })
  it('follows no link and reads no pipe', async () => {
    writeFileSync(join(dir, 'real'), 'real'); symlinkSync(join(dir, 'real'), join(dir, 'link')); execFileSync('mkfifo', [join(dir, 'pipe')])
    writeFileSync(join(dir, 'empty'), '')
    const hashes = await scriptHashes('link pipe empty', { exec: dir, project: dir, flow: dir })
    expect(hashes).toEqual([{ path: join(dir, 'empty'), sha256: sha('') }])
  })
  it('hashes a file bigger than one read', async () => {
    const content = Buffer.alloc(200 * 1024, 7)
    writeFileSync(join(dir, 'large'), content)
    expect(await scriptHashes('large', { exec: dir, project: dir, flow: dir })).toEqual([{ path: join(dir, 'large'), sha256: sha(content) }])
  })
})
