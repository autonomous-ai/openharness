import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
    // Claude Code writes .claude.json on its first run; a machine that ran it has one (kit/folderTrust.ts leaves none made).
    writeFileSync(join(claude, '.claude.json'), '{}')
    const folder = agentFolderFor(root, 's1')
    await prepareAgentFolder(folder, 'claude', { HOME: root, CLAUDE_CONFIG_DIR: claude })
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(existsSync(join(folder, AGENT_FOLDER_MARK))).toBe(true)
    const projects = JSON.parse(readFileSync(join(claude, '.claude.json'), 'utf8')).projects as Record<string, { hasTrustDialogAccepted?: boolean }>
    expect(Object.keys(projects)).toEqual([folder])
    expect(projects[folder].hasTrustDialogAccepted).toBe(true)
  })

  // The rehearsal's Codex builder (2026-11-11) worked only because its person's config trusted the whole home folder; anywhere
  // else Codex asks "Do you trust the files in this folder?" in a terminal no Swarm view shows.
  it('is trusted alone in Codex\'s config for a Codex agent', async () => {
    const root = temp('agent-root-'), codex = temp('agent-codex-')
    writeFileSync(join(codex, 'config.toml'), 'model = "gpt-5"\n')
    const folder = agentFolderFor(root, 's1')
    await prepareAgentFolder(folder, 'codex', { HOME: root, CODEX_HOME: codex })
    const config = readFileSync(join(codex, 'config.toml'), 'utf8')
    expect(config).toContain(`[projects."${folder}"]\ntrust_level = "trusted"`)
    expect(config.match(/\[projects\./g)).toHaveLength(1)
  })

  // Security review of #3341 (Readycheck): a folder or link already at that path was marked and trusted, and a link wrote
  // the mark outside. Only a folder Harness made, or one it made and marked before, is ever used.
  it('refuses a link or an unmarked folder already where it would go, and writes nothing through it', async () => {
    const root = temp('agent-root-'), outside = temp('agent-outside-'), claude = temp('agent-claude-')
    writeFileSync(join(claude, '.claude.json'), '{}')
    const env = { HOME: root, CLAUDE_CONFIG_DIR: claude }
    const linked = agentFolderFor(root, 'linked')
    mkdirSync(join(linked, '..'), { recursive: true })
    symlinkSync(outside, linked)
    await expect(prepareAgentFolder(linked, 'claude', env)).rejects.toThrow()
    expect(existsSync(join(outside, AGENT_FOLDER_MARK))).toBe(false)
    const planted = agentFolderFor(root, 'planted')
    mkdirSync(planted, { recursive: true })
    await expect(prepareAgentFolder(planted, 'claude', env)).rejects.toThrow()
    expect(existsSync(join(planted, AGENT_FOLDER_MARK))).toBe(false)
    expect(readFileSync(join(claude, '.claude.json'), 'utf8')).toBe('{}')
    // A link above it, in place of agent-home itself.
    const other = temp('agent-root-')
    mkdirSync(join(other, 'worktrees'), { recursive: true })
    symlinkSync(outside, join(other, 'worktrees', AGENT_FOLDERS))
    await expect(prepareAgentFolder(agentFolderFor(other, 'above'), 'claude', env)).rejects.toThrow()
    // Its own folder, made and marked by an earlier try of the same start, is used again.
    const again = agentFolderFor(root, 'again')
    await prepareAgentFolder(again, 'claude', env)
    await expect(prepareAgentFolder(again, 'claude', env)).resolves.toBeUndefined()
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
