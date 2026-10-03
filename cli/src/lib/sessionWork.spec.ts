import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { emptySessionWork, ingestSessionWork, sessionWorkSnapshot, shellWorkLocations, validSessionWork } from './sessionWork.js'

const at = '2026-09-27T13:00:00.000Z'
function fixture(engine = 'claude') {
  const state = emptySessionWork()
  const row = (value: Record<string, unknown>) => ingestSessionWork(state, { timestamp: at, ...value }, engine, '/home/silent-beacon')
  const start = (id: string, input: unknown, name = engine === 'claude' ? 'Bash' : 'exec_command') => row(engine === 'claude'
    ? { type: 'assistant', cwd: '/home/silent-beacon', message: { content: [{ type: 'tool_use', id, name, input }] } }
    : { type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) } })
  const finish = (id: string, output: unknown = 'ok', failed = false) => row(engine === 'claude'
    ? { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: failed }] } }
    : { type: 'response_item', payload: { type: 'function_call_output', call_id: id, output, is_error: failed } })
  return { state, row, start, finish, snapshot: () => sessionWorkSnapshot(state) }
}

describe('literal work location evidence', () => {
  it('resolves the hn worktree instead of the shell reset directory', () => {
    expect(shellWorkLocations('cd /worktrees/ship-hn/tui && cargo test --release --offline 2>&1 | grep result', '/worktrees/silent-beacon'))
      .toEqual({ paths: ['/worktrees/ship-hn/tui'], createsPr: false })
  })

  it.each([
    ['cd "/worktrees/ship hn/tui" && cargo test', ['/worktrees/ship hn/tui']],
    ["cd '/worktrees/ship hn' && cd tui && cargo test", ['/worktrees/ship hn/tui']],
    ['git -C ../ship-hn status', ['/worktrees/ship-hn']],
    ['echo "cd /worktrees/other && gh pr create"', ['/worktrees/silent-beacon']],
    ['# cd /not-used\npwd', ['/worktrees/silent-beacon']],
    ['cd /one && cargo test\ncd /two && cargo test', ['/one', '/two']],
    ["cd '/literal/$HOME' && pwd", ['/literal/$HOME']],
  ])('understands literal command %s', (command, paths) => {
    expect(shellWorkLocations(command, '/worktrees/silent-beacon')?.paths).toEqual(paths)
  })

  it.each([
    'cd "$TASK_DIR" && cargo test', 'cd /other; cargo test', 'cd /other || cargo test',
    'cd $(get-dir) && pwd', 'cd `get-dir` && pwd', 'cd /one && test & cd /two && test',
    'if true; then cd /other; fi', 'echo <<EOF\ncd /other\nEOF', 'bash -c "cd /other && test"',
    'env GIT_DIR=/other/.git git status', 'GIT_WORK_TREE=/other git status',
    'git --git-dir=/other/.git status', 'git -C /one -C /two status',
    'export GIT_DIR=/other/.git; git status', 'git --work-tree /other status',
    'pushd /other && test', '! cd /other && test', 'command cd /other && test',
    'cd /other && (echo hi)', 'cd "unterminated',
  ])('keeps ambiguous execution unknown: %s', command => {
    expect(shellWorkLocations(command, '/worktrees/silent-beacon')).toBeNull()
  })

  it('does not confuse quoted PR commands or later output with creation', () => {
    expect(shellWorkLocations('echo "gh pr create"', '/work')?.createsPr).toBe(false)
    expect(shellWorkLocations('gh pr create && echo https://github.com/a/b/pull/1', '/work')?.createsPr).toBe(false)
    expect(shellWorkLocations('cd /work && gh pr create --title "A fix"', '/home')?.createsPr).toBe(true)
  })
})

describe('per-session work receipts', () => {
  it('joins yielded process receipts to passive waits without promoting their completion order', () => {
    const f = fixture('codex')
    f.start('slow', { cmd: 'gh pr create', workdir: '/one' })
    f.finish('slow', JSON.stringify({ session_id: 14, output: '' }))
    expect(validSessionWork(JSON.parse(JSON.stringify(f.state)))).toBe(true)
    f.start('newer', { cmd: 'pwd', workdir: '/two' }); f.finish('newer')
    expect(f.snapshot()?.uncertain).toBe(true)
    f.start('poll', { session_id: 14, chars: '' }, 'write_stdin')
    f.finish('poll', JSON.stringify({ exit_code: 0, output: 'https://github.com/acme/app/pull/12' }))
    expect(f.snapshot()).toMatchObject({ uncertain: false, current: [{ cwd: '/two' }],
      pullRequests: [{ url: 'https://github.com/acme/app/pull/12', cwd: '/one' }] })
    expect(Object.keys(f.state.running)).toHaveLength(0)
  })
  it('joins code-mode cells and nested process waits without evaluating code', () => {
    const f = fixture('codex')
    f.row({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'code', name: 'exec',
      input: 'text(await tools.exec_command({cmd: "cargo test", workdir: "/ship-hn"}));' } })
    f.finish('code', 'Script running with cell ID cell-123')
    f.start('wait', { cell_id: 'cell-123' }, 'functions.wait')
    f.finish('wait', 'Script completed\nOutput:\n{"session_id":14,"output":""}')
    f.row({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'poll', name: 'exec',
      input: 'text(await tools.write_stdin({session_id: 14, chars: ""}));' } })
    f.finish('poll', 'Script completed\nOutput:\n{"exit_code":0,"output":"ok"}')
    expect(f.snapshot()).toMatchObject({ current: [{ cwd: '/ship-hn' }], uncertain: false })
  })
  it('does not infer a cwd from input sent to an interactive process', () => {
    const f = fixture('codex')
    f.start('shell', { cmd: 'zsh', workdir: '/old' })
    f.finish('shell', 'Process running with session ID 14')
    f.start('input', { session_id: 14, chars: 'cd /other\n' }, 'write_stdin')
    f.finish('input', 'Process exited with code 0')
    expect(f.snapshot()).toMatchObject({ current: [], uncertain: true })
  })
  it.each(['claude', 'codex'])('records successful %s tools, separately from launch cwd', engine => {
    const f = fixture(engine)
    f.start('one', { command: 'cd /worktrees/ship-hn/tui && cargo test' })
    expect(f.snapshot()).toMatchObject({ current: [], uncertain: true })
    f.finish('one')
    expect(f.snapshot()).toMatchObject({ current: [{ cwd: '/worktrees/ship-hn/tui', at }], uncertain: false })
    expect(validSessionWork(JSON.parse(JSON.stringify(f.state)))).toBe(true)
    expect(JSON.stringify(f.snapshot())).not.toContain('cargo')
  })

  it('keeps overlapping work uncertain and does not regress to an older call completing last', () => {
    const f = fixture()
    f.start('slow', { command: 'cd /one && test' })
    f.start('new', { command: 'cd /two && test' })
    f.finish('new')
    expect(f.snapshot()).toMatchObject({ uncertain: true })
    f.finish('slow')
    expect(f.snapshot()).toMatchObject({ current: [{ cwd: '/two' }], uncertain: false })
    expect(f.snapshot()?.locations.map(p => p.cwd).sort()).toEqual(['/one', '/two'])
  })

  it.each([
    ['failure', true], ['Process exited with code 1\nerror', false],
    [JSON.stringify({ exit_code: 1, output: 'oops' }), false],
    [JSON.stringify({ session_id: 14, output: '', exit_code: null }), false],
    ['Script running with cell ID 13', false],
  ])('never claims failed/running work was verified: %s', (output, error) => {
    const f = fixture()
    f.start('one', { command: 'cd /other && test' })
    f.finish('one', output, error)
    expect(f.snapshot()).toMatchObject({ current: [], locations: [], uncertain: true })
  })

  it('leaves known history intact after uncertain work and ignores unrelated tools', () => {
    const f = fixture()
    f.start('known', { command: 'cd /one && test' }); f.finish('known')
    f.start('search', { query: 'hello' }, 'WebSearch'); f.finish('search')
    expect(f.snapshot()?.uncertain).toBe(false)
    f.start('unknown', { command: 'cd "$TASK" && test' }); f.finish('unknown')
    expect(f.snapshot()).toMatchObject({ current: [{ cwd: '/one' }], locations: [{ cwd: '/one' }], uncertain: true })
  })

  it('uses explicit Codex workdir and turn context, including code mode without evaluation', () => {
    const f = fixture('codex')
    f.row({ type: 'turn_context', payload: { cwd: '/turn' } })
    f.start('explicit', { cmd: 'cargo test', workdir: '/specific' }); f.finish('explicit')
    expect(f.snapshot()?.current[0]?.cwd).toBe('/specific')
    f.start('default', { cmd: 'cargo test' }); f.finish('default')
    expect(f.snapshot()?.current[0]?.cwd).toBe('/turn')
    f.row({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'code', name: 'exec',
      input: 'text(await tools.exec_command({"cmd":"cargo test","workdir":"/code"}));' } })
    f.finish('code', JSON.stringify({ exit_code: 0, output: 'ok' }))
    expect(f.snapshot()?.current[0]?.cwd).toBe('/code')
    f.row({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'dynamic', name: 'exec',
      input: 'if (false) text(await tools.exec_command({"cmd":"test","workdir":"/fake"}));' } })
    f.finish('dynamic')
    expect(f.snapshot()).toMatchObject({ current: [{ cwd: '/code' }], uncertain: true })
  })

  it('tracks file tools without treating a mentioned path as a checkout', () => {
    const f = fixture()
    f.start('edit', { file_path: '/worktree/src/app.ts', old_string: '/another' }, 'Edit'); f.finish('edit')
    expect(f.snapshot()?.current[0]?.cwd).toBe('/worktree/src')
  })
  it('tracks patch file locations, including a literal code-mode patch', () => {
    const f = fixture('codex')
    const patch = '*** Begin Patch\n*** Update File: /ship-hn/tui/src/main.rs\n@@\n-old\n+new\n*** End Patch'
    f.row({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: patch } })
    f.finish('patch', 'Success. Updated the following files:\nM /ship-hn/tui/src/main.rs')
    expect(f.snapshot()?.current[0]?.cwd).toBe('/ship-hn/tui/src')
    f.row({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'code-patch', name: 'exec',
      input: `text(await tools.apply_patch(${JSON.stringify(patch)}));` } })
    f.finish('code-patch', 'Success. Updated the following files:\nM /ship-hn/tui/src/main.rs')
    expect(f.snapshot()?.current[0]?.cwd).toBe('/ship-hn/tui/src')
  })

  it('records several actual PR creation URLs once and never accepts prose, failures or lookups', () => {
    const f = fixture()
    const url = 'https://github.com/acme/app/pull/12'
    f.start('create', { command: 'cd /work && gh pr create --title "Fix"' }); f.finish('create', url)
    f.start('create', { command: 'gh pr create' }); f.finish('create', url)
    f.start('view', { command: 'gh pr view' }); f.finish('view', 'https://github.com/acme/app/pull/13')
    f.start('failed', { command: 'gh pr create' }); f.finish('failed', 'https://github.com/acme/app/pull/14', true)
    f.start('prose', { command: 'gh pr create' }); f.finish('prose', 'Created https://github.com/acme/app/pull/15')
    f.start('second', { command: 'gh pr create' }); f.finish('second', 'https://github.com/acme/app/pull/16')
    expect(f.snapshot()?.pullRequests).toEqual([
      { url: 'https://github.com/acme/app/pull/16', cwd: '/home/silent-beacon', at },
      { url, cwd: '/work', at },
    ])
  })

  it('keeps checkpoints bounded and rejects corrupt or executable-looking data', () => {
    const f = fixture()
    for (let i = 0; i < 140; i++) { f.start(`${i}`, { command: `cd /work/${i} && test` }); f.finish(`${i}`) }
    expect(f.snapshot()?.locations).toHaveLength(128)
    expect(f.snapshot()?.truncated).toBe(true)
    expect(validSessionWork(f.state)).toBe(true)
    expect(validSessionWork({ ...f.state, current: [{ cwd: '/bad\n', at }] })).toBe(false)
    expect(validSessionWork({ ...f.state, pullRequests: [{ url: 'javascript:bad', cwd: null, at }] })).toBe(false)
  })

  it('recovers this session’s yielded PR creation and parallel work from recorded Codex blocks', () => {
    const f = fixture('codex')
    f.row({ type: 'turn_context', payload: { cwd: '/workspace/happy-owl' } })
    const rows = readFileSync(new URL('./fixtures/session-work-codex.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    for (const row of rows) f.row(row)
    expect(f.snapshot()).toMatchObject({ uncertain: false,
      current: [{ cwd: '/workspace/happy-owl' }, { cwd: '/workspace/happy-owl/cli' }],
      pullRequests: [{ url: 'https://github.com/acme/app/pull/397', cwd: '/workspace/happy-owl' }] })
    expect(Object.keys(f.state.running)).toHaveLength(0)
    expect(validSessionWork(JSON.parse(JSON.stringify(f.state)))).toBe(true)
    // A later unsupported call cannot erase the checkout or PR we just verified.
    f.row({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'unsupported', name: 'exec', input: 'await arbitraryScript();' } })
    f.finish('unsupported')
    expect(f.snapshot()).toMatchObject({ uncertain: true, current: [{ cwd: '/workspace/happy-owl' }, { cwd: '/workspace/happy-owl/cli' }] })
    expect(f.snapshot()?.pullRequests).toHaveLength(1)
  })

  it('retains confirmed work during pending and failed commands without claiming the attempted checkout', () => {
    const f = fixture('codex')
    f.start('known', { cmd: 'pwd', workdir: '/confirmed' }); f.finish('known', '{"exit_code":0}')
    f.start('attempt', { cmd: 'test', workdir: '/unconfirmed' })
    expect(f.snapshot()).toMatchObject({ uncertain: true, current: [{ cwd: '/confirmed' }] })
    f.finish('attempt', '{"exit_code":1}')
    expect(f.snapshot()).toMatchObject({ uncertain: true, current: [{ cwd: '/confirmed' }] })
    expect(f.snapshot()?.locations.map(row => row.cwd)).toEqual(['/confirmed'])
  })

  it('does not trust missing, misindexed or rejected parallel receipts', () => {
    for (const result of [{ i: 1, status: 'fulfilled', value: { exit_code: 0 } }, { i: 0, status: 'rejected', reason: 'failed' }, {}]) {
      const f = fixture('codex')
      f.row({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'batch', name: 'exec',
        input: 'const results=await Promise.allSettled([tools.exec_command({cmd:"pwd",workdir:"/fake"})]); for(let i=0;i<results.length;i++) text({i,...results[i]});' } })
      f.finish('batch', [{ type: 'input_text', text: JSON.stringify(result) }])
      expect(f.snapshot()).toMatchObject({ uncertain: true, current: [], locations: [] })
    }
  })

  it('keeps parallel successes and failures distinct, regardless of output order', () => {
    const f = fixture('codex')
    f.row({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'batch', name: 'exec',
      input: 'const results=await Promise.all([tools.exec_command({cmd:"test",workdir:"/failed"}),tools.exec_command({cmd:"pwd",workdir:"/confirmed"})]); for(const result of results) text(result);' } })
    f.finish('batch', [{ type: 'input_text', text: '{"exit_code":1}' }, { type: 'input_text', text: '{"exit_code":0}' }])
    expect(f.snapshot()).toMatchObject({ uncertain: true, current: [{ cwd: '/confirmed' }], locations: [{ cwd: '/confirmed' }] })
    f.start('next', { cmd: 'pwd', workdir: '/next' }); f.finish('next', '{"exit_code":0}')
    expect(f.snapshot()).toMatchObject({ uncertain: false, current: [{ cwd: '/next' }] })
  })

  it('correlates a partially yielded batch across checkpoint and cell/process waits', () => {
    const f = fixture('codex')
    f.row({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'batch', name: 'exec',
      input: 'text(await tools.exec_command({cmd:"pwd",workdir:"/one"})); text(await tools.exec_command({cmd:"gh pr create",workdir:"/two"}));' } })
    f.finish('batch', [{ type: 'input_text', text: '{"exit_code":0,"output":"/one"}' },
      { type: 'input_text', text: 'Script running with cell ID cell-1' }])
    expect(f.snapshot()).toMatchObject({ uncertain: true, current: [{ cwd: '/one' }] })
    expect(validSessionWork(JSON.parse(JSON.stringify(f.state)))).toBe(true)
    f.start('cell-poll', { cell_id: 'cell-1' }, 'wait')
    f.finish('cell-poll', [{ type: 'input_text', text: 'Script completed\nOutput:\n' },
      { type: 'input_text', text: '{"session_id":77,"output":""}' }])
    f.start('process-poll', { session_id: 77, chars: '' }, 'write_stdin')
    f.finish('process-poll', '{"exit_code":0,"output":"https://github.com/acme/app/pull/12"}')
    expect(f.snapshot()).toMatchObject({ uncertain: false, current: [{ cwd: '/two' }],
      pullRequests: [{ url: 'https://github.com/acme/app/pull/12', cwd: '/two' }] })
    expect(Object.keys(f.state.running)).toHaveLength(0)
  })
})
