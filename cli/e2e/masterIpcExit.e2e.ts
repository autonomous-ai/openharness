/** A core can close its IPC channel before its update exit reaches the master. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until, type DaemonOptions } from './harness/daemon.js'

it('keeps the actual update exit when a status reply reaches a core whose IPC has closed', async () => {
  const options: DaemonOptions = { env: { HARNESSD_LEAN: 'off', HARNESSD_SERVICES: 'none', HARNESSD_UPDATE_PROBATION_MS: '100' } }
  const daemon = await IsolatedDaemon.create(options)
  const file = (name: string) => join(daemon.root, name)
  let paused: number | null = null
  let firstCore: number | null = null
  onTestFailed(() => { console.log(`---- daemon log\n${daemon.log()}`) })
  try {
    const build = file('build')
    let bundle = process.env.E2E_BUNDLE_PATH
    if (!bundle) {
      execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: build }, stdio: 'pipe' })
      bundle = join(build, 'cli.js')
    }
    const installed = file('installed')
    mkdirSync(installed)
    options.scriptPath = join(installed, 'cli.js')
    daemon.env.ADAPTER_CLI_DIR = installed
    // Found by QA after a quiet-machine run: CI mistook an IPC send error for the core's exit.
    // Hold the master while its first core closes IPC, then let the status replies fail before the
    // actual exit 75. Only this first core is faulted; the next runs the complete release bundle.
    const fault = `
if (process.argv[2] === '__run' && process.env.HARNESSD_RESTARTS === '0') {
  const fs = await import('node:fs');
  const wait = async (name) => { while (!fs.existsSync(${JSON.stringify(daemon.root)} + '/' + name)) await new Promise(r => setTimeout(r, 10)); };
  fs.writeFileSync(${JSON.stringify(file('first-core'))}, String(process.pid));
  await wait('send');
  await new Promise(r => process.send({type:'harnessd:bound',protocol:2,port:1}, r));
  await new Promise(r => process.send({type:'harnessd:ready'}, r));
  process.disconnect();
  fs.writeFileSync(${JSON.stringify(file('closed'))}, 'closed');
  await wait('exit');
  process.exit(75);
}
`
    writeFileSync(options.scriptPath, readFileSync(bundle, 'utf8').replace('\n', `\n${fault}\n`))
    writeFileSync(join(installed, 'package.json'), '{"type":"module"}\n')
    writeFileSync(join(installed, 'notify.mjs'), readFileSync(join(bundle, '..', 'notify.mjs')))
    await daemon.start({ ready: 'none' })
    await until('the first core', () => existsSync(file('first-core')))
    firstCore = Number(readFileSync(file('first-core'), 'utf8'))
    const master = daemon.pid!
    process.kill(master, 'SIGSTOP')
    paused = master
    writeFileSync(file('send'), '')
    await until('the core to close IPC', () => existsSync(file('closed')))
    process.kill(master, 'SIGCONT')
    paused = null
    await until('the master to receive the queued bind', () => daemon.log().includes(`core bound (pid ${firstCore},`))
    writeFileSync(file('exit'), '')
    await until('the next core to be ready', () => daemon.log().includes('[cli] ready'), 60_000)
    const status = await fetch(`http://127.0.0.1:${daemon.port}/api/status`).then(response => response.json()) as any
    expect(status.harnessd).toMatchObject({ state: 'running', restarts: 1, lastExit: 'code 75', lastExitReason: 'update', masterPid: master })
    await until('the update to be kept', () => daemon.log().includes('the update stayed up — keeping it'))
    expect(daemon.coresStarted()).toBe(2)

    const client = await LocalClient.connect(daemon)
    try {
      const cwd = join(daemon.projectsDir, 'after-ipc-close')
      mkdirSync(cwd)
      const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
      await until('the conversation to bind', async () => {
        const listed = await client.request('agents_list', {})
        return listed.agents.find((row: any) => row.id === created.agent.id && row.sessionId)
      })
      const ended = client.next(frame => frame.type === 'turn_ended' && frame.agentId === created.agent.id, 30_000, 'a turn after the update')
      client.send('message', { agentId: created.agent.id, content: 'still here after the update' })
      await ended
    } finally { client.close() }
  } finally {
    if (paused) { try { process.kill(paused, 'SIGCONT') } catch { /* already gone */ } }
    // The deliberately disconnected first core is ours even if a broken master replaced it early.
    writeFileSync(file('exit'), '')
    if (firstCore) await until('the first core to exit', () => !IsolatedDaemon.alive(firstCore), 10_000).catch(() => {
      try {
        const command = execFileSync('ps', ['-o', 'command=', '-p', String(firstCore)], { encoding: 'utf8' })
        if (command.includes(options.scriptPath!) && command.includes('__run')) process.kill(firstCore!, 'SIGKILL')
      } catch { /* gone */ }
    })
    await daemon.close()
  }
})
