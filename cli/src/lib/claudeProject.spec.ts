import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProjectMatches, claudeTranscriptCwd, isClaudeProjectTranscript, mangleClaudeProjectDir } from './claudeProject.js'

const dirs: string[] = []
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), 'claude-project-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const transcriptFor = (root: string, cwd: string, lines: Array<Record<string, unknown> | string>): string => {
  const dir = join(root, mangleClaudeProjectDir(cwd))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, lines.map((l) => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n')
  return path
}

describe('mangleClaudeProjectDir', () => {
  it('replaces every non-alphanumeric character with a dash, as Claude names its project dirs', () => {
    expect(mangleClaudeProjectDir('/Users/x/go/src/github.com/autonomous-ai/openharness')).toBe('-Users-x-go-src-github-com-autonomous-ai-openharness')
    expect(mangleClaudeProjectDir('/Users/x/.fleets/ws_1')).toBe('-Users-x--fleets-ws-1')
    expect(mangleClaudeProjectDir('/private/tmp/claude-502/-Users-x/probe')).toBe('-private-tmp-claude-502--Users-x-probe')
  })
})

describe('isClaudeProjectTranscript', () => {
  it('only a transcript inside a mangled project dir counts', () => {
    expect(isClaudeProjectTranscript('/home/u/.claude/projects/-home-u-repo/abc.jsonl')).toBe(true)
    expect(isClaudeProjectTranscript('/tmp/adapter-registry-XYZ/s1.jsonl')).toBe(false)
  })
})

describe('claudeProjectMatches', () => {
  it('accepts the folder itself and refuses a subfolder the shell moved into', () => {
    const t = '/home/u/.claude/projects/-home-u-repo/abc.jsonl'
    expect(claudeProjectMatches('/home/u/repo', t)).toBe(true)
    expect(claudeProjectMatches('/home/u/repo/cli', t)).toBe(false)
    expect(claudeProjectMatches('/home/u/other', t)).toBe(false)
  })
  it('accepts a path that only differs from the transcript by a symlink', () => {
    const root = scratch()
    const real = join(root, 'real'); mkdirSync(real)
    const link = join(root, 'link'); symlinkSync(real, link)
    const t = join(root, mangleClaudeProjectDir(realpathSync(real)), 'abc.jsonl')
    expect(claudeProjectMatches(link, t)).toBe(true)
  })
})

describe('claudeTranscriptCwd', () => {
  it('skips lines whose cwd drifted and returns the first one that is the project folder', () => {
    const root = scratch()
    const project = join(root, 'repo')
    const t = transcriptFor(root, project, [
      { type: 'mode', sessionId: 's' },
      'not json at all',
      { type: 'user', cwd: join(project, 'cli') },
      { type: 'user', cwd: join(root, 'elsewhere') },
      { type: 'user', cwd: project },
      { type: 'user', cwd: join(project, 'desktop') },
    ])
    expect(claudeTranscriptCwd(t)).toBe(project)
  })
  it('is null when no line names the folder, the file is missing, or it is not a Claude project transcript', () => {
    const root = scratch()
    const project = join(root, 'repo')
    const renamed = transcriptFor(root, project, [{ type: 'user', cwd: join(root, 'old-name') }])
    expect(claudeTranscriptCwd(renamed)).toBeNull()
    expect(claudeTranscriptCwd(join(root, mangleClaudeProjectDir(project), 'missing.jsonl'))).toBeNull()
    const plain = join(root, 'plain'); mkdirSync(plain)
    const notProject = join(plain, 's.jsonl'); writeFileSync(notProject, JSON.stringify({ cwd: project }) + '\n')
    expect(claudeTranscriptCwd(notProject)).toBeNull()
  })
  it('matches a folder whose name has multi-byte characters even when a chunk boundary splits one', () => {
    const root = scratch()
    const project = join(root, 'dự-án-thử')
    // The mangled name keeps only ASCII alphanumerics, so the folder still has a project dir of its own.
    const dir = join(root, mangleClaudeProjectDir(project)); mkdirSync(dir, { recursive: true })
    const t = join(dir, 's.jsonl')
    // Pad so the cwd line starts a few bytes before the 64 KiB chunk boundary.
    const pad = JSON.stringify({ type: 'assistant', text: 'y'.repeat(64 * 1024 - 60) })
    writeFileSync(t, pad + '\n' + JSON.stringify({ type: 'user', cwd: project }) + '\n')
    expect(claudeTranscriptCwd(t)).toBe(project)
  })

  it('stops at the scan cap and handles a match on the last, unterminated line', () => {
    const root = scratch()
    const project = join(root, 'repo')
    const filler = { type: 'assistant', text: 'x'.repeat(4000) }
    const t = transcriptFor(root, project, [...Array.from({ length: 10 }, () => filler), { type: 'user', cwd: project }])
    expect(claudeTranscriptCwd(t, 8 * 1024)).toBeNull()
    expect(claudeTranscriptCwd(t)).toBe(project)
    const dir = join(root, mangleClaudeProjectDir(project))
    const tail = join(dir, 'tail.jsonl')
    writeFileSync(tail, JSON.stringify({ type: 'user', cwd: project }))   // no trailing newline
    expect(claudeTranscriptCwd(tail)).toBe(project)
  })
})
