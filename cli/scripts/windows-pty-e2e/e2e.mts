// node e2e.mjs <command> [...args]: run ON the Windows machine, through run.cmd (docs/testing/windows-pty-e2e.md).
// State between invocations (a daemon restart in the middle of a scenario) is kept in C:\work\e2e\state.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { Client, log, sleep, tail } from './driver.mts'
import * as scenarios from './scenarios.mts'

const STATE = process.env.E2E_STATE ?? 'C:\\work\\e2e\\state.json'
const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2))
const [cmd, ...args] = process.argv.slice(2)
const c = await new Client().connect()
const brief = (a: any) => ({ id: a.id, engine: a.engine, status: a.status, launch: a.launch?.state, pane: a.tmuxPane, name: a.name, cwd: a.project?.cwd ?? a.cwd, resumeMode: a.resumeMode, sessionId: a.sessionId })

async function create(engine: string, cwd = process.env.E2E_PROJECT ?? 'C:\\work\\e2e\\proj', extra: Record<string, unknown> = {}) {
  const t0 = Date.now()
  const r = await c.rpc('agent_create', { engine, cwd, bypassPermission: false, ...extra }, 120_000)
  if (r.error) { log(`create ${engine} → ${r.error} ${r.detail ?? ''} ${JSON.stringify(r).slice(0, 600)}`); return null }
  log(`create ${engine} → ${r.agent.id} launch=${r.agent.launch?.state} (${Date.now() - t0} ms)`)
  return r.agent
}

async function waitReady(id: string, ms = 90_000) {
  return c.poll(`launch ready ${id}`, ms, async () => { const a = await c.row(id); return a?.launch?.state === 'ready' || a?.launch?.state === undefined && a?.status !== 'starting' ? a : undefined })
}

try {
  switch (cmd) {
    case 'list': {
      for (const a of await c.list()) console.log(JSON.stringify(brief(a)))
      break
    }
    case 'raw': {
      console.log(JSON.stringify((await c.list()).find((a) => a.id === args[0]), null, 2))
      break
    }
    case 'create': {
      const a = await create(args[0], args[1])
      if (a) console.log(JSON.stringify(brief(a)))
      break
    }
    case 'screen': {
      const s = await c.open(args[0], Number(args[1] ?? 120), Number(args[2] ?? 40), { passive: true })
      await sleep(1500)
      console.log(tail(await c.screen(s), Number(args[3] ?? 40)))
      break
    }
    case 'type': {
      const s = await c.open(args[0], 120, 40)
      await sleep(1000)
      c.input(s, args[1].replace(/\\r/g, '\r').replace(/\\n/g, '\n'))
      await sleep(Number(args[2] ?? 3000))
      console.log(tail(await c.screen(s), 30))
      break
    }
    case 'delete': {
      console.log(JSON.stringify(await c.rpc('agent_delete', { agentId: args[0] }, 60_000)))
      break
    }
    case 'resume': {
      console.log(JSON.stringify(await c.rpc('agent_resume', { agentId: args[0] }, 120_000)))
      break
    }
    default: {
      const run = (scenarios as Record<string, any>)[cmd]
      if (!run) throw new Error(`unknown command ${cmd}`)
      await run({ c, args, state, save, create, waitReady, brief })
    }
  }
} catch (e) {
  console.log(`FAIL ${(e as Error).stack ?? e}`)
  process.exitCode = 1
} finally {
  save()
  c.end()
  setTimeout(() => process.exit(process.exitCode ?? 0), 300)
}
