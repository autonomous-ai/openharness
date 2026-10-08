/**
 * What discovery reads off a process and a transcript, answer for answer, recorded from the code as it stood
 * before Claude Code's and Codex's discovery specifics became declared data applied by the kit
 * (docs/design/2026-10-08-engine-launch.md, (c3)):
 *
 *  - a corpus of process rows (native names, platform builds, npm and bun entrypoints, Claude's versioned
 *    native install, help probes, Windows paths, decoys and every other engine's) against every engine:
 *    the match score and its evidence, and whether the row is an unresolved `agent`;
 *  - argv against every engine: the session id it resumes, and the permission mode and approval it names;
 *  - a grid launch's argv and environment: the model it was pointed at;
 *  - a process environment: the profile home it runs under;
 *  - Claude Code transcripts: whether one sits in a project directory, which folder it belongs to, the folder
 *    it names for itself (past one read, a character across reads, a limit), and the folder a row with a
 *    drifted cwd is put back in at start-up.
 *
 * Every rule here runs on every discovery pass, or as the registry loads. Each case runs with `process.platform`
 * pinned to darwin and to linux, whichever machine runs the spec, and linux's are stored where they differ.
 *
 * `RECORD_DISCOVERY_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter what
 * discovery finds, and say so in that change.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { repairedCwd } from '../lib/cwdRepair.js'
import type { AgentCommandOwnershipSnapshot } from '../lib/engineBin.js'
import { classifyGridAssignment } from '../lib/gridAssignment.js'
import type { RegisteredSession } from '../lib/registry.js'
import { ambiguousAgentProcess, bypassPermissionActive, engineProcessMatch, permissionModeFromArgv, resumeSessionId, type ProcessRow } from '../lib/tmux.js'
import { profileHomeFromEnv, transcriptProject } from './discoveries.js'
import { ENGINES, PROCESS_ENGINES } from './types.js'

const GOLDEN = fileURLToPath(new URL('./__fixtures__/discovery.golden.json', import.meta.url))
const RECORD = process.env.RECORD_DISCOVERY_GOLDEN === '1'

/** No engine installed as far as file identity goes: the rules alone decide. */
const OWNERSHIP: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(),
  agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}
const ENGINE_PATHS = ['CLAUDE_PATH', 'CURSOR_PATH', 'OPENCODE_PATH', 'PI_PATH', 'HERMES_PATH', 'COMMANDCODE_PATH', 'DEVIN_PATH', 'MUSE_PATH',
  'AMP_PATH', 'KILO_PATH', 'GROK_PATH', 'AGY_PATH', 'COPILOT_PATH'] as const
const config = env as unknown as Record<string, string | undefined>
const saved: Record<string, string | undefined> = {}
let root = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'discovery-golden-')))
  for (const name of ENGINE_PATHS) { saved[name] = config[name]; config[name] = undefined }
  saved.CODEX_PATH = process.env.CODEX_PATH
  delete process.env.CODEX_PATH
})
afterAll(() => {
  for (const name of ENGINE_PATHS) config[name] = saved[name]
  if (saved.CODEX_PATH !== undefined) process.env.CODEX_PATH = saved.CODEX_PATH
  rmSync(root, { recursive: true, force: true })
})

const UUID = '01234567-89ab-cdef-0123-456789abcdef'

// ------------------------------------------------------------------------------------------- process rows

const EXECUTABLES = [
  'claude', 'Claude', 'CLAUDE', 'claude-helper', 'claudex', '/usr/local/bin/claude', '/opt/homebrew/bin/claude',
  '/opt/home/.local/share/claude/versions/2.1.246', '/opt/home/.local/share/Claude/versions/2.1.246', '2.1.246',
  '/opt/claude/versions/2.1.246', '/opt/home/.local/share/claude/versions/2.1.246/extra', 'C:\\home\\.local\\share\\claude\\versions\\2.1.2',
  'codex', 'Codex', 'codex-aarch64-apple-darwin', 'codex-x86_64-unknown-linux-musl', 'codex-x86_64-unknown-linux-gnu',
  'codex-x86_64-pc-windows-msvc', 'codex-arm64-apple-darwin', '/opt/homebrew/bin/codex', 'codexa',
  'node', 'bun', 'python3', 'bash', 'zsh', 'agent', 'cursor-agent', 'opencode', 'pi', 'hermes', 'cmd', 'muse', 'amp', 'kilo',
  'grok', 'agy', 'copilot', 'devin',
]
const ARGS: Array<(exe: string) => string> = [
  (exe) => exe,
  (exe) => `${exe} --resume ${UUID}`,
  (exe) => `${exe} resume ${UUID}`,
  (exe) => `${exe} --help`,
  (exe) => `${exe} --version`,
]
const ENTRYPOINT_ROWS: Array<Pick<ProcessRow, 'executable' | 'args'>> = [
  { executable: 'node', args: 'node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
  { executable: 'node', args: `node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume ${UUID}` },
  { executable: 'node', args: 'node --require /opt/x.js /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
  { executable: 'node', args: 'node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' },
  { executable: 'node', args: 'node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js --help' },
  { executable: 'node', args: 'node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.mjs' },
  { executable: 'node', args: 'node /opt/lib/node_modules/@openai/codex/bin/codex.js' },
  { executable: 'node', args: `node /opt/lib/node_modules/@openai/codex/bin/codex.js --no-daemon resume ${UUID}` },
  { executable: 'node', args: 'node /opt/lib/node_modules/@openai/codex/bin/codex' },
  { executable: 'node', args: 'node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js' },
  { executable: 'node', args: 'node /opt/lib/node_modules/@openai/codex/bin/codex.js --help' },
  { executable: 'node', args: 'node /opt/lib/node_modules/@openai/codex-sdk/bin/codex.js' },
  { executable: 'bun', args: 'bun /opt/.bun/install/global/node_modules/@openai/codex/bin/codex.js' },
  { executable: 'node', args: 'node -e "require(\'@openai/codex/bin/codex.js\')"' },
  { executable: 'node', args: 'node /opt/lib/node_modules/@github/copilot/npm-loader.js' },
  { executable: 'node', args: 'node /opt/cursor-agent/versions/2026.1/index.js' },
  { executable: 'python3', args: 'python3 /opt/hermes-agent/hermes' },
  { executable: 'claude', args: 'claude -p "summarise" --output-format json' },
  { executable: '/opt/home/.local/share/claude/versions/2.1.246', args: `/opt/home/.local/share/claude/versions/2.1.246 --resume ${UUID}` },
  { executable: 'node', args: '/opt/home/.local/share/claude/versions/2.1.246 --resume x' },
  { executable: 'bash', args: 'bash -c claude' },
  { executable: 'zsh', args: 'zsh -lic . /tmp/launch.sh harness-engine /work claude --resume x' },
  { executable: 'agent', args: 'agent' },
  { executable: 'codex', args: 'codex app-server --managed-daemon' },
]

function processCases(): Record<string, unknown> {
  const rows: Array<Pick<ProcessRow, 'executable' | 'args'>> = [
    ...EXECUTABLES.flatMap((exe) => ARGS.map((args) => ({ executable: exe, args: args(exe) }))),
    ...ENTRYPOINT_ROWS,
  ]
  const cases: Record<string, unknown> = {}
  for (const row of rows) {
    const key = `${row.executable} · ${row.args}`
    const matched = Object.fromEntries(ENGINES.flatMap((engine) => {
      const match = engineProcessMatch(row, engine, OWNERSHIP)
      return match.score > 0 ? [[engine, `${match.score} ${match.evidence}`]] : []
    }))
    cases[key] = { matched, ambiguous: ambiguousAgentProcess(row, OWNERSHIP) }
  }
  return cases
}

// ------------------------------------------------------------------------------------------------- argv

const ARGV = [
  'claude', `claude --resume ${UUID}`, `claude -r ${UUID}`, `claude --resume=${UUID}`, `claude --RESUME ${UUID}`, `claude -R ${UUID}`,
  `claude --resume ${UUID.toUpperCase()}`, `claude --resume ${UUID} --fork-session`, `claude --fork-session --resume ${UUID}`,
  `claude --resume "${UUID}"`, 'claude --resume 0123456789abcde', 'claude --resume 0123456789abcdef', `claude --resume  ${UUID}`,
  `claude --resume\t${UUID}`, 'claude --resume my-session-name', `claude -p "--resume ${UUID}"`, `claude --continue`,
  `codex resume ${UUID}`, `codex --no-daemon resume ${UUID}`, `codex resume --last`, `codex fork ${UUID}`, `codex resume=${UUID}`,
  `codex --approve-for-me resume ${UUID}`, `codex exec "resume ${UUID}"`, 'codex resume 0123',
  `node /opt/codex.js resume ${UUID}`, `cursor-agent --resume ${UUID}`, `opencode --session ses_abc123 --fork`, `opencode -s ses_abc123`,
  `pi --session ${UUID}`, 'hermes --resume 20260728_115628_f2c86a', 'devin -r brisk-otter', 'amp threads continue T-0123456789abcdef01',
  'claude --permission-mode auto', 'claude --permission-mode acceptEdits', 'claude --permission-mode=plan', 'claude --dangerously-skip-permissions',
  'claude --dangerously-skip-permissions --permission-mode auto', 'claude -p "--dangerously-skip-permissions"',
  'codex --approve-for-me', 'codex --sandbox read-only', 'codex --dangerously-bypass-approvals-and-sandbox', 'codex --sandbox=read-only',
]

function argvCases(): Record<string, unknown> {
  const cases: Record<string, unknown> = {}
  for (const args of ARGV) {
    cases[args] = Object.fromEntries(ENGINES.flatMap((engine) => {
      const resumed = resumeSessionId(engine, args)
      const mode = permissionModeFromArgv(engine, args)
      const approves = bypassPermissionActive(engine, args)
      return resumed || mode || approves ? [[engine, { resumed, mode, approves }]] : []
    }))
  }
  return cases
}

// ------------------------------------------------------------------------------------------- grid model

const RELAY = 'https://grid.example/relay/v1'
function gridCases(): Record<string, unknown> {
  const shapes: Array<[string, Record<string, string>, string]> = [
    ['argv with a model', {}, `codex -c model_providers.grid.base_url="${RELAY}" -m gpt-5`],
    ['argv, unquoted url', {}, `codex -c model_providers.grid.base_url=${RELAY} -m gpt-5`],
    ['argv, no model', {}, `codex -c model_providers.grid.base_url="${RELAY}"`],
    ['argv, the router', {}, `grok -c model_providers.grid.base_url="${RELAY}" -m Auto`],
    ['argv, a model in a prompt', {}, `codex -c model_providers.grid.base_url="${RELAY}" "-m nope"`],
    ['argv, not a relay', {}, 'codex -c model_providers.x.base_url="https://api.openai.com/v1" -m gpt-5'],
    ['environment', { ANTHROPIC_BASE_URL: RELAY, ANTHROPIC_MODEL: 'qwen', OPENAI_BASE_URL: RELAY, OPENAI_MODEL: 'qwen' }, 'claude -m other'],
    ['nothing', {}, 'codex -m gpt-5'],
  ]
  const cases: Record<string, unknown> = {}
  for (const [name, environment, args] of shapes) {
    cases[name] = Object.fromEntries(ENGINES.flatMap((engine) => {
      const found = classifyGridAssignment(engine, environment, args)
      return found ? [[engine, found]] : []
    }))
  }
  return cases
}

// ---------------------------------------------------------------------------------------------- profiles

function profileCases(): Record<string, unknown> {
  const real = join(root, 'codex-real')
  mkdirSync(real, { recursive: true })
  if (!existsSync(join(root, 'codex-link'))) symlinkSync(real, join(root, 'codex-link'))
  const shapes: Record<string, [Record<string, string>, string | undefined]> = {
    'unset': [{}, '/daemon/.codex'],
    'the default': [{ CODEX_HOME: '/daemon/.codex' }, '/daemon/.codex'],
    'another profile': [{ CODEX_HOME: '/profiles/work' }, '/daemon/.codex'],
    'the default through a link': [{ CODEX_HOME: join(root, 'codex-link') }, real],
    'the default with a trailing dot': [{ CODEX_HOME: join(real, '.') }, real],
    'relative': [{ CODEX_HOME: 'relative/codex' }, '/daemon/.codex'],
    'a control character': [{ CODEX_HOME: '/bad\nline' }, '/daemon/.codex'],
    'DEL': [{ CODEX_HOME: '/bad\x7fdel' }, '/daemon/.codex'],
    'too long': [{ CODEX_HOME: `/${'x'.repeat(4096)}` }, '/daemon/.codex'],
    'just long enough': [{ CODEX_HOME: `/${'x'.repeat(4095)}` }, '/daemon/.codex'],
    'empty': [{ CODEX_HOME: '' }, '/daemon/.codex'],
    'the daemon\'s own default': [{ CODEX_HOME: '/profiles/other' }, undefined],
    'another engine\'s variable': [{ CLAUDE_CONFIG_DIR: '/profiles/claude' }, '/daemon/.codex'],
  }
  const cases: Record<string, unknown> = {}
  for (const [name, [environment, defaultHome]] of Object.entries(shapes)) {
    cases[name] = Object.fromEntries(ENGINES.flatMap((engine) => {
      const found = profileHomeFromEnv(engine, environment, defaultHome)
      return found !== null ? [[engine, found.split(root).join('<root>')]] : []
    }))
  }
  return cases
}

// ---------------------------------------------------------------------------------- transcript projects

function projectCases(): Record<string, unknown> {
  const project = transcriptProject('claude')!
  const work = join(root, 'my work', 'repo.v2')
  const sub = join(work, 'sub dir')
  mkdirSync(sub, { recursive: true })
  if (!existsSync(join(root, 'linked-work'))) symlinkSync(work, join(root, 'linked-work'))
  const projects = join(root, 'projects')
  const dir = join(projects, project.directoryOf(work))
  mkdirSync(dir, { recursive: true })
  const line = (cwd: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', cwd, ...extra })
  const files: Record<string, string | Buffer> = {
    'first line': `${line(work)}\n`,
    'drifted first, then home': `${line(sub)}\n${line('/tmp')}\n${line(work)}\n`,
    'no matching line': `${line(sub)}\n${line('/elsewhere')}\n`,
    'a cwd that is not text': `${line(42)}\n${line(null)}\n${line(work)}\n`,
    'invalid JSON lines': `{"cwd": broken\n${line(work)}\n`,
    'cwd mentioned in text only': `${JSON.stringify({ type: 'assistant', text: `"cwd":"${work}"` })}\n`,
    'no final newline': line(work),
    'empty': '',
    'past one read': `${line(sub, { pad: 'é'.repeat(40_000) })}\n${line(work)}\n`,
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, `${name}.jsonl`), text)
  // A three-byte character across the first 64 KiB read, in the line that names the folder.
  const unicodeWork = join(root, 'caf\u00e9 \u2713')
  mkdirSync(unicodeWork, { recursive: true })
  const unicodeDir = join(projects, project.directoryOf(unicodeWork))
  mkdirSync(unicodeDir, { recursive: true })
  const head = `${line(sub, { pad: 'a'.repeat(65_536 - 40) })}\n`
  writeFileSync(join(unicodeDir, 'split.jsonl'), `${head}${line(unicodeWork)}\n`)
  const outside = join(root, 'not-a-project', 'x.jsonl')
  mkdirSync(join(root, 'not-a-project'), { recursive: true })
  writeFileSync(outside, `${line(work)}\n`)
  const norm = (value: unknown): unknown => JSON.parse(JSON.stringify(value).split(project.directoryOf(root)).join('<mangled-root>').split(root).join('<root>'))

  const cases: Record<string, unknown> = {}
  for (const name of [...Object.keys(files), 'missing']) {
    const path = join(dir, `${name}.jsonl`)
    cases[`transcript · ${name}`] = norm({
      isProjectTranscript: project.isProjectTranscript(path),
      cwdOf: project.cwdOf(path),
      // A read cap shorter than the line that names the folder finds nothing. 16 bytes ends inside any line's
      // `{"cwd":"…` on every host; 100 ended inside it only where the temp root is long (macOS), not on Linux CI.
      cwdOfCutShort: project.cwdOf(path, 16),
      belongs: Object.fromEntries([work, sub, join(root, 'linked-work'), `${work}/`, '/elsewhere', join(root, 'my-work', 'repo-v2')]
        .map((cwd) => [cwd.split(root).join('<root>'), project.belongs(cwd, path)])),
    })
  }
  cases['transcript · a character across reads'] = norm({ cwdOf: project.cwdOf(join(unicodeDir, 'split.jsonl')) })
  cases['transcript · outside a project directory'] = norm({ isProjectTranscript: project.isProjectTranscript(outside), cwdOf: project.cwdOf(outside) })
  cases['directory names'] = norm(Object.fromEntries(['/', '/a b/c.d', '/a_b-c', 'relative/x', '/caf\u00e9', 'C:\\x\\y', ''].map((cwd) => [cwd, project.directoryOf(cwd)])))
  for (const engine of PROCESS_ENGINES.filter((name) => name !== 'claude')) cases[`no rule · ${engine}`] = transcriptProject(engine)

  // The start-up repair of a row whose cwd drifted from its transcript's folder.
  const row = (over: Partial<RegisteredSession>): RegisteredSession => ({ agentId: 'abcdef0123456789', engine: 'claude', cwd: sub, transcriptPath: join(dir, 'first line.jsonl'), ...over }) as RegisteredSession
  const rows: Record<string, RegisteredSession> = {
    'a drifted claude row': row({}),
    'a claude row at home': row({ cwd: work }),
    'a claude row through a link': row({ cwd: join(root, 'linked-work') }),
    'a claude row whose transcript names none': row({ transcriptPath: join(dir, 'no matching line.jsonl') }),
    'a claude row whose transcript is elsewhere': row({ transcriptPath: outside }),
    'a claude row with no transcript': row({ transcriptPath: null }),
    'a claude row with no cwd': row({ cwd: '' }),
    'a codex row': row({ engine: 'codex' }),
    'a terminal row': row({ engine: 'terminal' }),
  }
  for (const [name, value] of Object.entries(rows)) {
    const logged: string[] = []
    cases[`repair · ${name}`] = norm({ folder: repairedCwd(value, (message) => logged.push(message)), logged })
  }
  return cases
}

type Sections = Record<string, Record<string, unknown>>
const PLATFORMS = ['darwin', 'linux'] as const

/** Every section, with `process.platform` reading `platform`. */
function sectionsOn(platform: (typeof PLATFORMS)[number]): Sections {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...real, value: platform })
  try {
    return { process: processCases(), argv: argvCases(), grid: gridCases(), profile: profileCases(), project: projectCases() }
  } finally { Object.defineProperty(process, 'platform', real) }
}

describe('discovery finds what it did before Claude Code and Codex declared it', () => {
  it('process rows, argv, grid models, profiles and transcript projects match the record, on darwin and linux', () => {
    const darwin = sectionsOn('darwin')
    const linux = sectionsOn('linux')
    const linuxDiffers = Object.fromEntries(Object.entries(linux).map(([section, cases]) => [section,
      Object.fromEntries(Object.entries(cases).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(darwin[section]![key])))]))
    if (RECORD) {
      const block = (cases: Record<string, unknown>): string => Object.entries(cases).map(([key, value]) => ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n')
      const sections = (all: Sections): string => Object.entries(all).map(([section, cases]) => `${JSON.stringify(section)}: {\n${block(cases)}\n}`).join(',\n')
      writeFileSync(GOLDEN, `{\n${sections(darwin)},\n"linux": {\n${sections(linuxDiffers)}\n}\n}\n`)
      return
    }
    const { linux: linuxGolden, ...darwinGolden } = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Sections & { linux: Sections }
    for (const [platform, actual, golden] of [
      ['darwin', darwin, darwinGolden],
      ['linux', linux, Object.fromEntries(Object.entries(darwinGolden).map(([section, cases]) => [section, { ...cases, ...linuxGolden[section] }]))],
    ] as const) {
      expect(Object.keys(actual), platform).toEqual(Object.keys(golden))
      for (const [section, cases] of Object.entries(golden)) {
        expect(Object.keys(actual[section]!).sort(), `${platform} · ${section}`).toEqual(Object.keys(cases).sort())
        for (const [key, value] of Object.entries(cases)) expect(actual[section]![key], `${platform} · ${section} · ${key}`).toEqual(value)
      }
    }
  })

  it('records no machine-specific path', () => {
    const text = readFileSync(GOLDEN, 'utf8')
    expect(text).not.toContain('discovery-golden-')
    expect(text).not.toContain(root)
    expect(text).not.toMatch(/\/Users\/|\/home\/runner/)
  })
})
