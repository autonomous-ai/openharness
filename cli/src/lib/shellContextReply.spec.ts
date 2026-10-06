import { afterEach, expect, it } from 'vitest'
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellContextReply } from './shellContextReply.js'

const homes: string[] = []
const context = '8c73ea55-683a-4207-a9aa-ab8a9e813bea'
const payload = {context, id:'12-34-56', code:0, text:'a model with spaces'}
function fixture() {
  const home = mkdtempSync(join(tmpdir(),'hn-shell-fifo-')); homes.push(home)
  const dir = join(home,'.harness','shell-requests',context)
  mkdirSync(dir,{recursive:true,mode:0o700})
  return {home, file:join(dir,payload.id)}
}
afterEach(() => { for (const h of homes.splice(0)) rmSync(h,{recursive:true,force:true}) })
it('writes data only to the waiting private FIFO and never needs terminal input', () => {
  const {home,file} = fixture()
  execFileSync('/usr/bin/mkfifo',['-m','600',file])
  const fd = openSync(file,constants.O_RDWR | constants.O_NONBLOCK)
  try {
    expect(shellContextReply(payload,home)).toBe(true)
    const data = Buffer.alloc(512), count = readSync(fd,data)
    expect(data.subarray(0,count).toString()).toBe(`HN:${payload.id}:0:${Buffer.from(payload.text).toString('base64')}\n`)
  } finally { closeSync(fd) }
})
it('rejects traversal, oversized responses, regular files and symlinks without modifying them', () => {
  const {home,file} = fixture()
  writeFileSync(file,'untouched',{mode:0o600})
  for (const p of [payload,{...payload,id:'../escape'},{...payload,context:'../escape'},{...payload,text:'x'.repeat(2049)},{...payload,code:2}]) {
    expect(shellContextReply(p,home)).toBe(false)
  }
  expect(readFileSync(file,'utf8')).toBe('untouched')
  const other = join(home,'other'); writeFileSync(other,'other')
  rmSync(file); symlinkSync(other,file)
  expect(shellContextReply(payload,home)).toBe(false)
  expect(readFileSync(other,'utf8')).toBe('other')
})
it('does not block on a cancelled or missing request', () => {
  const {home,file} = fixture()
  expect(shellContextReply(payload,home)).toBe(false)
  execFileSync('/usr/bin/mkfifo',['-m','600',file])
  expect(shellContextReply(payload,home)).toBe(false)
})
it('delivers a large catalog atomically with a short FIFO acknowledgement', () => {
  const {home,file} = fixture()
  execFileSync('/usr/bin/mkfifo',['-m','600',file])
  const fd = openSync(file,constants.O_RDWR | constants.O_NONBLOCK)
  const data = {rows: Array.from({length:1000},(_,i)=>({id:String(i),label:`Saved conversation ${i}`}))}
  try {
    expect(shellContextReply({...payload,data},home)).toBe(true)
    expect(JSON.parse(readFileSync(file+'.json','utf8'))).toEqual(data)
    expect(statSync(file+'.json').mode & 0o777).toBe(0o600)
    const buffer = Buffer.alloc(512)
    expect(readSync(fd,buffer)).toBeGreaterThan(0)
    expect(shellContextReply({...payload,data:'x'.repeat(8*1024*1024)},home)).toBe(false)
  } finally { closeSync(fd) }
})
it('does not follow a catalog symlink or write a catalog for an absent reader', () => {
  const {home,file} = fixture()
  const other = join(home,'other'); writeFileSync(other,'untouched')
  symlinkSync(other,file+'.json')
  execFileSync('/usr/bin/mkfifo',['-m','600',file])
  const fd = openSync(file,constants.O_RDWR | constants.O_NONBLOCK)
  try { expect(shellContextReply({...payload,data:{rows:[]}},home)).toBe(false) }
  finally { closeSync(fd) }
  expect(readFileSync(other,'utf8')).toBe('untouched')
  rmSync(file+'.json')
  expect(shellContextReply({...payload,data:{rows:[]}},home)).toBe(false)
})
