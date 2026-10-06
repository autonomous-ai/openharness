import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { expect, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from '../e2e/harness/client.js'
import { IsolatedDaemon, until } from '../e2e/harness/daemon.js'
import { realEnginePlan, redactRealEngineOutput, type RealEngine } from '../src/testing/realEnginePolicy.js'

export const plan = realEnginePlan(process.env)
export const isAgentFrame = (type: string, id: string) => (frame: Frame) => frame.type === type && frame.agentId === id
const quote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/** Every record read by these tests must have been written by a real CLI under this fresh fixture. */
export class RealFixture {
  client?: LocalClient
  agent: Record<string, any> = {}
  readonly cwd: string
  private constructor(readonly daemon: IsolatedDaemon, readonly engine: RealEngine) {
    this.cwd = join(daemon.projectsDir, 'synthetic')
  }

  static async create(engine: RealEngine): Promise<RealFixture> {
    const d = await IsolatedDaemon.create()
    const fixture = new RealFixture(d, engine)
    // Registered before any daemon/server can start, including a start that fails halfway through.
    appendFileSync(join(process.env.REAL_ENGINE_RUN_ROOT!, 'sockets'), `${d.tmux.socket}\n`)
    onTestFailed(async () => {
      const screen = fixture.agent.tmuxPane ? await d.capture(fixture.agent.tmuxPane).catch(String) : ''
      console.log(redactRealEngineOutput(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}\n---- pane\n${screen}`,
        process.env, process.env.REAL_ENGINE_RUN_ROOT!))
    })
    try {
      Object.assign(d.env, {
        CLAUDE_CONFIG_DIR: join(d.root, 'claude'), HOOK_INSTALL_ENGINES: engine,
        XDG_CONFIG_HOME: join(d.root, 'config'), XDG_DATA_HOME: join(d.root, 'share'),
        XDG_CACHE_HOME: join(d.root, 'cache'), XDG_STATE_HOME: join(d.root, 'state'),
      })
      for (const env of [d.env, d.tmux.env]) {
        if (engine === 'claude') delete env.OPENAI_API_KEY
        else delete env.CLAUDE_CODE_OAUTH_TOKEN
      }
      // The shared fixture initially writes fakes. Replace BOTH launchers, so an accidental engine
      // selection can never make a real-engine assertion pass against a fake.
      for (const name of ['claude', 'codex']) {
        const binary = name === engine ? process.env[`REAL_${name.toUpperCase()}_BINARY`] : undefined
        if (name === engine && (!binary || !isAbsolute(binary))) throw new Error(`Missing resolved real ${name} binary`)
        writeFileSync(join(d.root, 'bin', name), binary
          ? `#!/bin/sh\nexec ${quote(binary)} "$@"\n` : '#!/bin/sh\necho "Unselected real engine refused" >&2\nexit 126\n', { mode: 0o755 })
      }
      mkdirSync(fixture.cwd, { recursive: true })
      execFileSync('git', ['init', '-q', fixture.cwd], { env: d.env, timeout: 10_000, stdio: 'pipe' })
      writeFileSync(join(fixture.cwd, 'AGENTS.md'), 'This is a disposable QA project. Use only files in this directory. Never read credentials, environment variables, other homes or network resources. Follow the short test prompt exactly.\n')
      writeFileSync(join(fixture.cwd, 'three-lines.txt'), 'alpha\nbeta\ngamma\n')
      writeFileSync(join(fixture.cwd, 'context.txt'), Array.from({ length: 512 }, (_, n) => `Synthetic item ${n}: the sample counter is ${n % 7}; all sample names are invented.\n`).join(''))
      writeFileSync(join(fixture.cwd, 'hold.mjs'), `import { existsSync, writeFileSync } from 'node:fs';\nwriteFileSync('tool-started', 'ready');\nconst end = Date.now() + 90000;\nwhile (!existsSync('tool-release') && Date.now() < end) await new Promise(r => setTimeout(r, 100));\nif (!existsSync('tool-release')) throw new Error('QA hold deadline');\nconsole.log('QA_HOLD_RELEASED');\n`)
      writeFileSync(join(d.env.CLAUDE_CONFIG_DIR!, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }))
      writeFileSync(join(d.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ model: plan.models.claude,
        permissions: { allow: ['Read', 'Bash(node hold.mjs)'] } }))
      writeFileSync(join(d.env.CODEX_HOME!, 'config.toml'), [
        `model = ${JSON.stringify(plan.models.codex ?? 'unselected')}`, 'model_provider = "qa_real"',
        'check_for_update_on_startup = false', 'sandbox_mode = "workspace-write"', 'approval_policy = "never"',
        '[model_providers.qa_real]', 'name = "QA environment key"', 'base_url = "https://api.openai.com/v1"',
        'wire_api = "responses"', 'env_key = "OPENAI_API_KEY"',
        '[features]', 'hooks = true', 'multi_agent_v2 = true', 'apps = false', 'plugins = false', 'remote_plugin = false', '',
      ].join('\n'))
      await d.start()
      fixture.client = await LocalClient.connect(d)
      const result = await fixture.client.request('agent_create', { engine, cwd: fixture.cwd,
        permissionMode: 'ask', model: plan.models[engine] }, 90_000)
      expect(result.error, JSON.stringify(result)).toBeUndefined()
      fixture.agent = result.agent
      await until('the real engine pane', async () => {
        const row = await fixture.row()
        if (row?.tmuxPane) { fixture.agent = row; return true }
        return false
      }, 30_000)
      return fixture
    } catch (error) { await fixture.close(); throw error }
  }

  async row(): Promise<Record<string, any> | undefined> {
    const page = await this.client!.request('agents_list', { includeStopped: true })
    return page.agents.find((row: Record<string, any>) => row.id === this.agent.id)
  }

  async trustScreen(): Promise<string> {
    return until('the real folder trust screen', async () => {
      const screen = await this.daemon.capture(this.agent.tmuxPane)
      return this.engine === 'claude'
        ? (/Quick safety check/.test(screen) && /Yes, I trust this folder/.test(screen) ? screen : null)
        : (/Trust this folder\?|Do you trust the contents/.test(screen) && /1\. (?:Trust and continue|Yes, continue)/.test(screen) ? screen : null)
    }, 30_000)
  }

  async acceptTrust(): Promise<void> {
    const screen = await this.trustScreen()
    const keys = this.engine === 'claude'
      ? (/❯\s*Yes, I trust this folder/.test(screen) ? ['Enter'] : ['Up', 'Enter']) : ['1', 'Enter']
    await this.daemon.tmux.run('send-keys', '-t', this.agent.tmuxPane, ...keys)
    let reviewed = false
    await until('a conversation bound by the real engine', async () => {
      const pane = await this.daemon.capture(this.agent.tmuxPane)
      if (this.engine === 'codex' && !reviewed && /Hooks need review/.test(pane)) {
        // The only hook file in this new home was installed by this isolated daemon.
        await this.daemon.tmux.run('send-keys', '-t', this.agent.tmuxPane, 'Down', 'Enter')
        reviewed = true
        return false
      }
      const row = await this.row()
      if (row?.sessionId && row.status === 'active') { this.agent = row; return true }
      return false
    }, 60_000, 250)
  }

  async type(text: string): Promise<void> {
    await this.daemon.tmux.run('send-keys', '-l', '-t', this.agent.tmuxPane, text)
    await this.daemon.tmux.run('send-keys', '-t', this.agent.tmuxPane, 'Enter')
  }

  async turn(content: string): Promise<void> {
    const since = this.client!.frames.length
    this.client!.send('message', { agentId: this.agent.id, content })
    await this.client!.waitFor(isAgentFrame('turn_ended', this.agent.id), 120_000, 'real turn ended', since)
    expect(this.client!.frames.slice(since).filter(isAgentFrame('turn_started', this.agent.id))).toHaveLength(1)
    expect(this.client!.frames.slice(since).filter(isAgentFrame('turn_ended', this.agent.id))).toHaveLength(1)
    await this.idle()
  }

  async idle(): Promise<void> {
    await until('idle after the real turn', async () => (await this.row())?.activity?.state === 'idle', 20_000, 250)
  }

  async history(): Promise<Frame[]> {
    const page = await this.client!.request('session_get', { sessionId: this.agent.sessionId, limit: 200 })
    expect(page.error, JSON.stringify(page)).toBeUndefined()
    return page.events ?? []
  }

  async userOnce(marker: string): Promise<void> {
    const matches = () => this.history().then((events) => events.filter((event) => event.type === 'user_message' && String(event.payload?.content).includes(marker)))
    await until(`history containing ${marker}`, async () => (await matches()).length > 0, 15_000)
    expect(await matches(), `one history message containing ${marker}`).toHaveLength(1)
  }

  native(): Array<Record<string, any>> {
    const root = this.engine === 'claude' ? this.daemon.env.CLAUDE_PROJECTS_DIR! : join(this.daemon.env.CODEX_HOME!, 'sessions')
    const records: Array<Record<string, any>> = []
    let bytes = 0
    const visit = (folder: string): void => {
      if (!existsSync(folder)) return
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const file = join(folder, entry.name)
        if (entry.isDirectory()) visit(file)
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          bytes += statSync(file).size
          if (bytes > 8 * 1024 * 1024) throw new Error('Native record evidence exceeds 8 MiB')
          for (const line of readFileSync(file, 'utf8').split('\n')) {
            try { records.push(JSON.parse(line)) } catch { /* a final line may still be in flight */ }
          }
        }
      }
    }
    visit(root)
    return records
  }

  async hold(marker: string): Promise<number> {
    const since = this.client!.frames.length
    this.client!.send('message', { agentId: this.agent.id,
      content: `${marker}: Run exactly node hold.mjs in this project, wait for it to finish, then report its output. Do not run it in the background or change the script.` })
    await until('the real tool to write its start marker', () => existsSync(join(this.cwd, 'tool-started')), 90_000)
    await this.client!.waitFor(isAgentFrame('tool_start', this.agent.id), 10_000, 'live tool_start', since)
    return since
  }

  release(): void { if (existsSync(this.cwd)) writeFileSync(join(this.cwd, 'tool-release'), 'release') }

  async settle(): Promise<void> { await pause(2_000) }

  async close(): Promise<void> {
    this.release()
    this.client?.close()
    const rel = relative(process.env.REAL_ENGINE_RUN_ROOT!, this.daemon.root)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Refusing cleanup outside this real-engine run')
    await this.daemon.close()
    if (this.daemon.pid && IsolatedDaemon.alive(this.daemon.pid)) throw new Error('The fixture daemon survived cleanup')
    if (existsSync(this.daemon.tmux.socket)) throw new Error('The fixture tmux socket survived cleanup')
  }
}
