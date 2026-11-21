import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { envFilePath, EnvIssue, flag, homePath, homeRelative, matching, maybe, maybeNumber, number, oneOf, parseEnv, text, unlessFalse, url } from './envFields.js'

// The values a variable can arrive with: unset, empty, padded, and the ones each kind is about.
const VALUES = [undefined, '', ' ', 'true', 'false', 'TRUE', '0', '42', ' 7 ', 'x', 'test', 'prod', 'stag',
  'https://mirror.example/catalog', ' https://mirror.example/x ', 'http://127.0.0.1:9/c', 'http://localhost/c', 'http://[::1]/c',
  'http://mirror.example/c', 'https://user:pass@mirror.example/c', 'ftp://mirror.example', 'http:mirror.example', 'feature/x-1.2']

/** What zod's schema made of [value]: the value, or `issue` when it refused it. */
function viaZod(schema: z.ZodType, value: string | undefined): unknown {
  const parsed = z.object({ V: schema }).safeParse(value === undefined ? {} : { V: value })
  return parsed.success ? (parsed.data as { V: unknown }).V : 'issue'
}
function viaField(field: (raw: string | undefined) => unknown, value: string | undefined): unknown {
  try { return field(value) } catch (error) { if (error instanceof EnvIssue) return 'issue'; throw error }
}

describe('an environment variable read as zod read it', () => {
  const accept = (address: URL) => !address.username && !address.password && (address.protocol === 'https:'
    || (address.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)))
  const kinds: Array<[string, z.ZodType, (raw: string | undefined) => unknown]> = [
    ['a string with a default', z.string().default('d'), text('d')],
    ['a string or nothing', z.string().optional(), maybe],
    ['a number with a default', z.string().default('5000').transform(Number), number('5000')],
    ['a number or nothing', z.string().optional().transform((value) => value === undefined ? undefined : Number(value)), maybeNumber],
    ['a flag, off by default', z.string().default('false').transform((v) => v === 'true'), flag('false')],
    ['a flag, on by default', z.string().default('true').transform((v) => v === 'true'), flag('true')],
    ['on unless false', z.string().default('true').transform((v) => v !== 'false'), unlessFalse],
    ['one of a few', z.enum(['development', 'production', 'test']).default('development'), oneOf(['development', 'production', 'test'], 'development')],
    ['a pattern or nothing', z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/).optional().catch(undefined), matching(/^[A-Za-z0-9._/-]{1,200}$/)],
  ]
  it.each(kinds)('%s', (_kind, schema, field) => {
    for (const value of VALUES) expect(viaField(field, value), JSON.stringify(value)).toEqual(viaZod(schema, value))
  })

  it('a URL or nothing, as zod read every URL, and nothing for what zod threw on as it loaded', () => {
    const schema = z.string().url().refine((value) => accept(new URL(value))).optional().catch(undefined)
    for (const value of VALUES) {
      let expected: unknown
      // zod ran the refinement on a value it had already refused as a URL, and `new URL` threw out of it.
      try { expected = viaZod(schema, value) } catch { expected = undefined }
      expect(viaField(url(accept), value), JSON.stringify(value)).toEqual(expected)
    }
    expect(url(accept)(' https://mirror.example/x ')).toBe('https://mirror.example/x')
    expect(url(accept)('not a url')).toBeUndefined()
  })

  it('says what one of a few must be', () => {
    expect(() => oneOf(['prod', 'stag'], 'prod')('dev')).toThrow('Invalid option: expected one of "prod"|"stag"')
  })
})

describe('a Harness folder or file override', () => {
  it('is an absolute value as given and a relative one under the home, never under the current folder', () => {
    expect(homePath('/abs', '/h')).toBe('/abs')
    expect(homePath('data', '/h')).toBe(join('/h', 'data'))
    expect(homePath('', '/h')).toBe('')
  })

  // The daemon's socket folder is named by a hash of the data folder as written (lib/localSocket.ts), and Desktop and
  // the Store's clients keep an absolute one as given: a tidied one would name another socket.
  it('is an absolute value exactly as written, untidy or not', () => {
    for (const value of ['/abs/', '/abs//data', '/abs/./data/../data']) expect(homePath(value, '/h')).toBe(value)
  })

  // `ADAPTER_DATA_DIR=` in an env file must never make the home itself the data folder.
  it('is its default when unset or empty', () => {
    const field = homeRelative('/fallback')
    expect(field(undefined)).toBe('/fallback')
    expect(field('')).toBe('/fallback')
    expect(field('data')).toBe(join(homedir(), 'data'))
    expect(field('/abs')).toBe('/abs')
  })

  it('names the env file HARNESS_ENV_FILE names, else DOTENV_CONFIG_PATH, trimmed and under the home', () => {
    expect(envFilePath({ HARNESS_ENV_FILE: ' harness.env ', DOTENV_CONFIG_PATH: '/other.env' }, '/h')).toBe(join('/h', 'harness.env'))
    expect(envFilePath({ HARNESS_ENV_FILE: ' ', DOTENV_CONFIG_PATH: ' /other.env ' }, '/h')).toBe('/other.env')
    expect(envFilePath({ DOTENV_CONFIG_PATH: 'dot.env' })).toBe(join(homedir(), 'dot.env'))
    expect(envFilePath({ HARNESS_ENV_FILE: '' }, '/h')).toBeNull()
  })
})

describe('the environment read whole', () => {
  const fields = { PORT: number('18473'), NODE_ENV: oneOf(['development', 'test'], 'development'), MODE: oneOf(['a', 'b'], 'a'), NAME: maybe }

  it('is every variable\'s value, unknown variables left out', () => {
    expect(parseEnv(fields, { PORT: '9', NODE_ENV: 'test', OTHER: 'x' })).toEqual({ ok: true, data: { PORT: 9, NODE_ENV: 'test', MODE: 'a', NAME: undefined } })
  })

  it('is every issue, by variable, when any has one', () => {
    expect(parseEnv(fields, { NODE_ENV: 'prod', MODE: 'c' })).toEqual({
      ok: false,
      issues: { NODE_ENV: ['Invalid option: expected one of "development"|"test"'], MODE: ['Invalid option: expected one of "a"|"b"'] },
    })
  })

  it('lets anything but an issue through: a bug is not a bad variable', () => {
    expect(() => parseEnv({ BROKEN: () => { throw new TypeError('a bug') } }, {})).toThrow('a bug')
  })
})
