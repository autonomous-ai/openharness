/** A child that refuses stdin must fail its operation, not crash the provider process. */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'provider-stdin-'))
const claudeBin = join(root, 'early-exit.sh')

beforeAll(() => {
  writeFileSync(claudeBin, '#!/bin/sh\nexit 1\n')
  chmodSync(claudeBin, 0o755)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

// Isolate the provider code in a process: an unhandled stream error must really
// exit that process, rather than being swallowed by the test runner's handlers.
function run(code: string): unknown {
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    timeout: 5_000,
  }))
}

describe('closed child stdin', () => {
  it('finishes a failed turn without treating it as a user cancellation', () => {
    const result = run(`
      import { runTurn } from ${JSON.stringify(new URL('./claude.js', import.meta.url).href)};
      const handle = runTurn({
        claudeBin: ${JSON.stringify(claudeBin)}, cwd: ${JSON.stringify(root)},
        text: 'x'.repeat(512 * 1024),
      }, () => {});
      console.log(JSON.stringify(await handle.done));
    `) as { code: number | null; killed: boolean; inputError?: string }
    expect(result.killed).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.inputError).toContain('EPIPE')
  })

  it('falls back to an excerpt when the recap process refuses its input', () => {
    const result = run(`
      import { summariseTurn } from ${JSON.stringify(new URL('./recap.js', import.meta.url).href)};
      const recap = await summariseTurn({
        claudeBin: ${JSON.stringify(claudeBin)}, cwd: ${JSON.stringify(root)},
        turnText: 'Result. ' + '結'.repeat(50_000),
      });
      console.log(JSON.stringify(recap));
    `) as { recap: string; body: string }
    expect(result.recap).toBe('Result.')
    expect(result.body).toContain('Result. 結')
  })

  it('reports turn_failed over HTTP and keeps serving other requests', () => {
    const result = run(`
      import { createProviderServer } from ${JSON.stringify(new URL('./server.js', import.meta.url).href)};
      const { server } = createProviderServer({
        agents: [{ id: 'fixture', name: 'Fixture', cwd: ${JSON.stringify(root)} }],
        workspaceRoot: ${JSON.stringify(root)}, agentsFile: ${JSON.stringify(join(root, 'agents.json'))},
        claudeBin: ${JSON.stringify(claudeBin)}, port: 0,
        stateFile: ${JSON.stringify(join(root, 'state.json'))},
        claudeProjectsDir: ${JSON.stringify(join(root, 'projects'))}, recapDisabled: true,
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = 'http://127.0.0.1:' + server.address().port;
      const rpc = (method, params) => fetch(url, {
        method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      try {
        const response = await rpc('agent.send', {
          agentId: 'fixture', turnId: 'fixture-turn', message: { text: 'x'.repeat(512 * 1024) },
        });
        const stream = await response.text();
        const list = await (await rpc('agent.list', {})).json();
        console.log(JSON.stringify({ stream, agents: list.result.agents }));
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    `) as { stream: string; agents: Array<{ id: string }> }
    expect(result.stream).toContain('"kind":"turn_failed"')
    expect(result.stream).not.toContain('"kind":"turn_cancelled"')
    expect(result.agents.map(agent => agent.id)).toEqual(['fixture'])
  })
})
