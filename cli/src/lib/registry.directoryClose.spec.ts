import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownProcessGroup } from './windows/noWindow.js'

it.skipIf(process.platform === 'win32').each(['published', 'preparation', 'status'] as const)(
  'seals a writer with an uncertain directory close and observes its actual %s process exit', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'registry-close-process-')), data = join(root, 'data')
    for (const folder of ['data', 'home', 'runtime']) mkdirSync(join(root, folder), { mode: 0o700 })
    writeFileSync(join(data, 'engine-homes.json'), '{}', { mode: 0o600 })
    writeFileSync(join(data, 'registry.json'), JSON.stringify([{ launcherId: 'fixture-close', engine: 'claude',
      sessionId: '', transcriptPath: null, tmuxPane: '%1', projectDir: 'fixture', cwd: root,
      processIdentity: null, registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1 }]), { mode: 0o600 })
    const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./__fixtures__/registryDirectoryClose.ts', import.meta.url)), data, mode], {
      ...ownProcessGroup(), cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
        HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), TMPDIR: root,
        ADAPTER_DATA_DIR: data, ADAPTER_RUNTIME_DIR: join(root, 'runtime'), HARNESS_AUTH_DIR: join(root, 'home', 'auth'),
        PORT: '0', ADAPTER_COMPUTER_ID: 'fixture-close', TERM: 'dumb', LANG: 'en_US.UTF-8' },
    })
    let stdout = '', stderr = '', exited = false, closed = false, outEOF = false, errEOF = false, timedOut = false
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-16384) })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16384) })
    child.stdout.once('end', () => { outEOF = true }); child.stderr.once('end', () => { errEOF = true })
    child.once('exit', () => { exited = true })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 20_000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('close', code => { closed = true; resolve(code) }); child.once('error', reject)
      })
      expect({ code, timedOut, exited, closed, outEOF, errEOF }, stderr).toEqual({ code: 0, timedOut: false, exited: true, closed: true, outEOF: true, errEOF: true })
      const result = JSON.parse(readFileSync(join(data, 'close-receipt.json'), 'utf8'))
      expect(result).toMatchObject({ attempts: 1, afterFailureWrites: 0, cleanExit: false, lockRetained: true, uncertainDescriptorOpen: true })
      if (mode === 'status') {
        expect(stderr).toContain('[registry] status flush failed')
        expect(stdout).toContain('stopped')
      } else {
        expect(result.outcome).toMatchObject({ name: mode === 'published' ? 'AtomicWriteUnconfirmed' : 'RegistryPersistenceUnavailable' })
        if (mode === 'published') expect(result.outcome).toMatchObject({ retryable: false })
        expect(result.refused).toMatchObject({ name: 'RegistryPersistenceUnavailable', message: expect.stringContaining('restart') })
      }
    } finally {
      clearTimeout(timer)
      if (closed) rmSync(root, { recursive: true, force: true })
    }
  },
)
