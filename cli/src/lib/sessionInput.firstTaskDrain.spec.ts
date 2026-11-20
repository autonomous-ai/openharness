import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'

// The broken queue starves timers, including Vitest's timeout. Bound it from a separate process.
it.each(['before', 'after'])('a message admitted %s failed first-task preflight leaves the core event loop available', async when => {
  const source = new URL('./sessionInput.ts', import.meta.url).href
  const script = `
    import { SessionInputController } from ${JSON.stringify(source)};
    const row = { schemaVersion:2, active:true, agentId:'a', sessionId:'s', engine:'openclaw', registeredAt:1,
      boundAt:1, runtimes:[], primaryRuntimeKey:null, processIdentity:null };
    const injected = [];
    const input = new SessionInputController({ getSession:()=>row, validateRuntime:async()=>false,
      readScreen:async()=>null, submission:{ policy:()=>undefined }, capture:async()=>null,
      inject:async(_id,text)=>{ injected.push(text); return true }, sendKey:async()=>true, onError:()=>{} });
    input.expectFirstTask('s','First');
    if (process.argv[1] === 'before') input.submit('s','Later');
    input.submitFirstTask('s','First');
    setTimeout(() => {
      if (process.argv[1] === 'after') input.submit('s','Later');
      setTimeout(() => {
        const waiting = input.firstTaskWaiting('s');
        input.forget('s');
        console.log('RESULT:' + JSON.stringify({ waiting, injected }));
      }, 0);
    }, 0);
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, when], {
    cwd: new URL('../../', import.meta.url), windowsHide: true, timeout: 8_000, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data.toString() })
  child.stderr.on('data', data => { stderr += data.toString() })
  const ended = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  expect(ended, 'the child must finish through its timer, not the external starvation deadline').toEqual({ code: 0, signal: null })
  expect(stderr).toBe('')
  const answer = stdout.split('\n').find(line => line.startsWith('RESULT:'))
  expect(answer).toBeDefined()
  expect(JSON.parse(answer!.slice(7))).toEqual({ waiting: true, injected: [] })
}, 12_000)
