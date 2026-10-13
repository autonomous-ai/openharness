/** Healthy file and link contents from main, before immutable launch publications. */
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const artifact = fileURLToPath(new URL('./__fixtures__/grid-config-compatibility.golden.json', import.meta.url))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let root: string
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'grid-config-golden-')))
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.stubEnv('TZ', 'UTC'); vi.stubEnv('HOME', root); vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.resetModules()
})
afterAll(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
it('preserves the files selected by fresh and changed grid launches and their borrowed sessions', async () => {
  const { publishGridConfigDir } = await import('./publishedGridConfig.js')
  const target = join(root, 'native-sessions'); mkdirSync(target)
  writeFileSync(join(target, 'session.json'), '{"fixture":"retained conversation"}\n')
  const actual: Record<string, unknown> = {}
  for (const [name, files, links] of [
    ['pi', [{ name: 'models.json', content: '{"providers":{"fixture":{"apiKey":"GRID_API_KEY"}}}\n' }, { name: 'settings.json', content: '{"skills":["/fixture/skills"]}\n' }], []],
    ['opencode', [{ name: 'opencode.json', content: '{"provider":{"fixture":{"npm":"@ai-sdk/openai-compatible"}}}\n' }], []],
    ['grok', [{ name: 'settings.json', content: '{"baseUrl":"https://fixture.invalid/v1"}\n' }], [{ name: 'sessions', target }]],
    ['pi', [{ name: 'models.json', content: '{"providers":{"other":{"apiKey":"GRID_API_KEY"}}}\n' }, { name: 'settings.json', content: '{"skills":["/fixture/skills"]}\n' }], []],
  ] as const) {
    const { directory } = await publishGridConfigDir(name, files, links)
    actual[`${name}-${Object.keys(actual).length}`] = {
      files: Object.fromEntries(files.map(file => [file.name, readFileSync(join(directory, file.name), 'utf8')])),
      links: Object.fromEntries(links.map(link => [link.name, readlinkSync(join(directory, link.name)).replace(root, '<root>')])),
      conversation: readFileSync(join(target, 'session.json'), 'utf8'),
    }
  }
  if (process.env.RECORD_GRID_CONFIG_GOLDEN === '1') writeFileSync(artifact, JSON.stringify(actual, null, 2) + '\n')
  else expect(actual).toEqual(JSON.parse(readFileSync(artifact, 'utf8')))
})
