import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCodexOneShot } from './oneshot.js'

let directory: string | null = null
afterEach(() => { vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }) })

describe('the companion Codex review worker', () => {
  it('keeps its selected login, model and effort and cannot be discovered as a terminal agent', async () => {
    directory = mkdtempSync(join(tmpdir(), 'companion-worker-'))
    const binary = join(directory, 'codex-fixture')
    const capture = join(directory, 'launch.json')
    writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', data => prompt += data);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args: process.argv.slice(2), prompt,
    codexHome: process.env.CODEX_HOME, tmux: process.env.TMUX, pane: process.env.TMUX_PANE}));
  fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], '{"lesson":null}');
});
`, { mode: 0o700 })
    vi.stubEnv('CODEX_PATH', binary)
    vi.stubEnv('TMUX', 'a-real-terminal')
    vi.stubEnv('TMUX_PANE', '%42')
    const profile = join(directory, 'selected-login')
    expect(await runCodexOneShot({ prompt: 'review only this evidence', cwd: directory,
      codexHome: profile, model: 'selected-model', effort: 'xhigh', timeoutMs: 3000 })).toEqual({ text: '{"lesson":null}', sessionId: null })
    const launch = JSON.parse(readFileSync(capture, 'utf8'))
    expect(launch.codexHome).toBe(profile)
    expect(launch.args).toEqual(expect.arrayContaining(['--model', 'selected-model', 'model_reasoning_effort="xhigh"',
      '--ephemeral', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules']))
    expect(launch.tmux).toBeUndefined()
    expect(launch.pane).toBeUndefined()
    expect(launch.prompt.trim()).toBe('review only this evidence')
  })
})
