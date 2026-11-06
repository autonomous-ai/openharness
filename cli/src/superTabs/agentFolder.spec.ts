import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { worktreeFolderName } from '../lib/agentNames.js'
import { AGENT_FOLDER_MARK, AGENT_FOLDERS, agentFolderFor, prepareAgentFolder, removableAgentFolder, temporaryFolder } from './agentFolder.js'

const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); made.push(dir); return dir }

// Scholes, 11-06 (#3713): project computer's agent Dee started in a Claude scratchpad, a temporary folder Claude asks
// "Do you trust this folder?" about on every run, in a terminal no Swarm view shows.
describe('a temporary folder', () => {
  it('is one under the system temporary folders, as written or resolved', () => {
    for (const path of ['/tmp/x', '/private/tmp/claude-501/-Users-mac/abc/scratchpad', '/var/tmp/a', '/var/folders/ab/xy/T/x',
      '/private/var/folders/ab/xy/T/x', join(tmpdir(), 'x')]) expect(temporaryFolder(path), path).toBe(true)
  })

  it('is not a project, the person\'s own folder, or a folder only named like one', () => {
    for (const path of ['/Users/me/work', '/tmp-not/x', '/Users/me/tmp/x', '/home/me/harnesses/worktrees/repo/leaf', 'relative/tmp', '/tmp'])
      expect(temporaryFolder(path), path).toBe(false)
  })
})

describe('the folder Harness makes for an agent whose start named a temporary one', () => {
  it('is named for its start, in Harness\'s own agent-home folder', () => {
    expect(agentFolderFor('/root', 's1')).toBe(join('/root', 'worktrees', AGENT_FOLDERS, worktreeFolderName('super-tab/s1')))
  })

  it('is made private, marked as Harness\'s, and trusted alone in Claude\'s settings', async () => {
    const root = temp('agent-root-'), claude = temp('agent-claude-')
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = claude
    try {
      const folder = agentFolderFor(root, 's1')
      await prepareAgentFolder(folder, 'claude')
      expect(statSync(folder).mode & 0o777).toBe(0o700)
      expect(existsSync(join(folder, AGENT_FOLDER_MARK))).toBe(true)
      const projects = JSON.parse(readFileSync(join(claude, '.claude.json'), 'utf8')).projects as Record<string, { hasTrustDialogAccepted?: boolean }>
      expect(Object.keys(projects)).toEqual([folder])
      expect(projects[folder].hasTrustDialogAccepted).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  it('may be removed only when it is a marked folder directly in agent-home', async () => {
    const root = temp('agent-root-')
    const folder = agentFolderFor(root, 's2')
    mkdirSync(folder, { recursive: true })
    expect(removableAgentFolder(folder, root)).toBe(false)
    writeFileSync(join(folder, AGENT_FOLDER_MARK), '')
    expect(removableAgentFolder(folder, root)).toBe(true)
    for (const other of [join(root, 'worktrees', AGENT_FOLDERS), join(root, 'worktrees', 'repo', 'leaf'), join(folder, 'inner'), '/tmp'])
      expect(removableAgentFolder(other, root), other).toBe(false)
  })
})
