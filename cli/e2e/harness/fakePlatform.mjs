/**
 * Fake `launchctl`, `systemctl` and `loginctl` for the end-to-end tests of `harness service` and of
 * `harness start`/`stop` under a platform (e2e/cli.e2e.ts). Unlike the unit tests' fake
 * (src/testing/fakePlatform.ts) this one RUNS the master: it reads the definition `harness service
 * install` wrote, the plist's ProgramArguments or the unit's ExecStart, and starts it detached with its
 * environment, working directory and log, as launchd and systemd do. Its stops signal that master.
 *
 * Put the folder of these scripts first on the PATH the CLI is given: they shadow the real ones by
 * name, and nothing in the CLI names the real ones by path. Every call is recorded (calls.jsonl).
 *
 * Two modes, in config.json beside the scripts:
 *   forbidden  every call fails loudly (exit 99): for a machine where no platform may be asked at all.
 *   platform   a small launchd or systemd. Stop jobs (`systemctl stop`, `restart`, `disable --now`) fail
 *              loudly too: tmux built with systemd support makes every pane PartOf the unit, and the CLI
 *              must never send one (harnessd/platform.ts `stop`).
 *
 * The master is given the test's isolated environment (config.baseEnv) beside the definition's own, as
 * launchd gives a job its own environment beside the plist's. It refuses to start one without a private
 * TMUX_TMPDIR: a master on the person's own tmux server is the one thing this must never make.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const LABEL = 'ai.autonomous.harness.harnessd'
const UNIT = 'harnessd.service'

export async function run(name) {
  const dir = dirname(process.argv[1])
  const argv = process.argv.slice(2)
  appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify([name, ...argv])}\n`)
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  const stateFile = join(dir, 'state.json')
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { loaded: false, enabled: false, pid: null }
  const save = () => writeFileSync(stateFile, JSON.stringify(state))
  const end = (status, message) => {
    if (message) process.stderr.write(`${message}\n`)
    save()
    process.exit(status)
  }
  const loudly = (why) => end(99, `FAKE ${name} ${argv.join(' ')}: ${why}`)
  if (config.mode !== 'platform') loudly('called on a machine where no platform may be asked')

  const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
  const running = () => alive(state.pid)
  const startMaster = (job) => {
    const env = { ...config.baseEnv, ...job.env }
    if (!env.TMUX_TMPDIR || !config.baseEnv.TMUX_TMPDIR || env.TMUX) loudly('refusing to start a master without a private tmux server')
    const log = openSync(job.log, 'a')
    const child = spawn(job.argv[0], job.argv.slice(1), { cwd: job.cwd, env, detached: true, stdio: ['ignore', log, log] })
    closeSync(log)
    child.unref()
    state.pid = child.pid
    state.started = (state.started ?? 0) + 1
  }
  const waitGone = async (pid, ms) => {
    const deadline = Date.now() + ms
    while (alive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  }

  if (name === 'launchctl') {
    const [verb, target, file] = argv
    const service = `gui/${process.getuid()}/${LABEL}`
    switch (verb) {
      case 'print':
        if (target === `gui/${process.getuid()}`) { process.stdout.write(`${target} = {\n\ttype = Aqua\n}\n`); end(0) }
        if (target !== service) loudly('unexpected target')
        if (!state.loaded) end(113, `Could not find service "${LABEL}" in domain for port`)
        process.stdout.write(`${service} = {\n\tstate = ${running() ? 'running' : 'not running'}\n${running() ? `\tpid = ${state.pid}\n` : ''}\tlast exit code = 0\n}\n`)
        end(0)
      case 'enable':
        if (target !== service) loudly('unexpected target')
        end(0)
      case 'bootstrap': {
        if (target !== `gui/${process.getuid()}` || !file) loudly('unexpected arguments')
        if (state.loaded) end(5, 'Bootstrap failed: 5: Input/output error')
        state.loaded = true
        startMaster(plist(readFileSync(file, 'utf8')))   // RunAtLoad
        state.file = file
        end(0)
      }
      case 'kickstart':
        if (target !== service) loudly('unexpected target')
        if (!state.loaded) end(113, `Could not find service "${LABEL}" in domain for port`)
        if (!running()) startMaster(plist(readFileSync(state.file, 'utf8')))
        end(0)
      case 'bootout': {
        if (target !== service) loudly('unexpected target')
        if (!state.loaded) end(3, 'Boot-out failed: 3: No such process')
        const pid = state.pid
        state.loaded = false
        state.pid = null
        save()
        if (alive(pid)) { process.kill(pid, 'SIGTERM'); await waitGone(pid, 10_000) }
        end(0)
      }
      default: loudly('not a verb this fake knows')
    }
  }

  if (name === 'systemctl') {
    if (argv[0] !== '--user') loudly('only the user manager is ours to ask')
    const [verb, ...rest] = argv.slice(1)
    const unitFile = join(config.baseEnv.XDG_CONFIG_HOME, 'systemd', 'user', UNIT)
    switch (verb) {
      case 'daemon-reload': state.loaded = existsSync(unitFile); end(0)
      case 'reset-failed': end(0)
      case 'show': {
        if (rest[0] !== UNIT) loudly('unexpected unit')
        const pid = running() ? state.pid : 0
        if (rest.includes('--property=MainPID')) { process.stdout.write(`MainPID=${pid}\n`); end(0) }
        process.stdout.write(`LoadState=${state.loaded ? 'loaded' : 'not-found'}\nUnitFileState=${state.enabled ? 'enabled' : state.loaded ? 'disabled' : ''}\nActiveState=${pid ? 'active' : 'inactive'}\nSubState=${pid ? 'running' : 'dead'}\nMainPID=${pid}\nResult=success\n`)
        end(0)
      }
      case 'enable':
        if (rest.at(-1) !== UNIT) loudly('unexpected unit')
        state.enabled = true
        if (rest.includes('--now') && !running()) startMaster(unit(readFileSync(unitFile, 'utf8')))
        end(0)
      case 'start':
        if (rest[0] !== UNIT) loudly('unexpected unit')
        if (!running()) startMaster(unit(readFileSync(unitFile, 'utf8')))
        end(0)
      case 'kill': {
        if (rest.at(-1) !== UNIT || !rest.includes('--kill-who=main') || !rest.includes('--signal=SIGTERM')) loudly('unexpected arguments')
        if (!running()) end(1, `Failed to kill unit ${UNIT}: No main process to kill`)
        process.kill(state.pid, 'SIGTERM')   // systemctl kill does not wait; the CLI does
        end(0)
      }
      case 'disable':
        if (rest.includes('--now')) loudly('a stop job: it would stop every pane PartOf the unit')
        state.enabled = false
        end(0)
      case 'stop':
      case 'restart':
        loudly('a stop job: it would stop every pane PartOf the unit')
      default: loudly('not a verb this fake knows')
    }
  }

  if (name === 'loginctl') { process.stdout.write('Linger=yes\n'); end(0) }
  loudly('not faked')
}

const unxml = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** The job in a plist `harness service install` wrote. */
function plist(text) {
  const body = text.replace(/<!--[\s\S]*?-->/g, '')
  const value = (key) => unxml(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(body)?.[1] ?? '')
  const argv = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(body)?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]))
  const env = {}
  for (const m of (/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(body)?.[1] ?? '').matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) env[unxml(m[1])] = unxml(m[2])
  return { argv, env, cwd: value('WorkingDirectory'), log: value('StandardOutPath') }
}

/** systemd's quoting, as harnessd/platform.ts writes it: double-quoted words with C escapes. */
function words(line) {
  const out = []
  let at = 0
  while (at < line.length) {
    while (line[at] === ' ') at++
    if (at >= line.length) break
    if (line[at] !== '"') { const next = line.indexOf(' ', at); out.push(line.slice(at, next < 0 ? undefined : next)); at = next < 0 ? line.length : next; continue }
    let word = ''
    at++
    while (at < line.length && line[at] !== '"') {
      if (line[at] === '\\') { word += line[at + 1]; at += 2 } else { word += line[at]; at++ }
    }
    out.push(word)
    at++
  }
  return out
}

/** The job in a unit `harness service install` wrote. */
function unit(text) {
  const job = { argv: [], env: {}, cwd: '', log: '' }
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (line.startsWith('#') || at < 0) continue
    const key = line.slice(0, at)
    const value = line.slice(at + 1)
    if (key === 'ExecStart') job.argv = words(value).map((word, index) => (index ? word.replace(/\$\$/g, '$') : word).replace(/%%/g, '%'))
    if (key === 'Environment') { const [pair] = words(value); const eq = pair.indexOf('='); job.env[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/%%/g, '%') }
    if (key === 'WorkingDirectory') job.cwd = value.replace(/%%/g, '%')
    if (key === 'StandardOutput' && value.startsWith('append:')) job.log = value.slice('append:'.length).replace(/%%/g, '%')
  }
  return job
}
