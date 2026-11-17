import { afterEach, describe, expect, it, vi } from 'vitest'
import { listOpencodeCommands, parseOpencodeCommandList, resetOpencodeCommandListCache } from './commandList.js'

// `opencode api GET /api/command` on MSI (opencode 2.2.6, 2026-11-17), trimmed.
const ANSWER = JSON.stringify({ location: { directory: '/home/me' }, data: [
  { name: 'init', description: 'guided AGENTS.md setup' },
  { name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted' },
  { name: 'notion:make-this-a-notion-page', description: 'Turn the current work into a durable Notion page.\nMore lines.' },
  { name: 'rm -rf', description: 'not a name anyone types' },
  { name: 'init', description: 'twice' },
] })

afterEach(() => resetOpencodeCommandListCache())

describe('the commands OpenCode offers', () => {
  it('keeps what a `/` list shows: the screen\'s commands a chat can use, then each of its own with its first line', () => {
    expect(parseOpencodeCommandList(ANSWER)?.slice(0, 4).map((c) => c.name)).toEqual(['models', 'effort', 'compact', 'new'])
    expect(parseOpencodeCommandList(ANSWER)?.slice(4)).toEqual([
      { name: 'init', description: 'guided AGENTS.md setup', argumentHint: '' },
      { name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted', argumentHint: '' },
      { name: 'notion:make-this-a-notion-page', description: 'Turn the current work into a durable Notion page.', argumentHint: '' },
    ])
    // An OpenCode before 2 answers its web page, or nothing.
    expect(parseOpencodeCommandList('<!doctype html>')).toBeNull()
    expect(parseOpencodeCommandList('{"data":{}}')).toBeNull()
  })

  it('asks once per folder while the answer is fresh, and again for a folder of its own', async () => {
    let now = 0
    const run = vi.fn(async () => ANSWER)
    const options = { run, now: () => now }
    const [first, second] = await Promise.all([listOpencodeCommands({ cwd: '/w' }, options), listOpencodeCommands({ cwd: '/w' }, options)])
    expect(first).toHaveLength(7)
    expect(second).toBe(first)
    expect(run).toHaveBeenCalledTimes(1)
    await listOpencodeCommands({ cwd: '/other' }, options)
    expect(run.mock.calls).toEqual([['/w'], ['/other']])
    now += 6 * 60_000
    await listOpencodeCommands({ cwd: '/w' }, options)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('is null when OpenCode could not be asked, and asks again next time', async () => {
    const run = vi.fn(async () => { throw new Error('no api') })
    expect(await listOpencodeCommands({ cwd: null }, { run })).toBeNull()
    expect(await listOpencodeCommands({ cwd: null }, { run })).toBeNull()
    expect(run).toHaveBeenCalledTimes(2)
  })
})
