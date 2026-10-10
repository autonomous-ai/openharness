import { expect, it } from 'vitest'
import { descriptorPaths, parseDescriptors } from './nativeDescriptors.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
const file = (fd = '3', path = '/rollout.jsonl', inode = '9007199254740993') => `f${fd}\0tREG\0D0x100000000000001\0i${inode}\0n${path}\0\n`
const parse = (text: string) => parseDescriptors(text, 42, new NativeEvidenceBudget())

it('retains exact device/inode numbers, repeated library maps and complete empty listings', () => {
  const rows = parse('p42\0\n' + file() + file('txt', '/a', '2') + file('txt', '/b', '3'))
  expect(rows[0]).toMatchObject({ fd: '3', path: '/rollout.jsonl', inode: 9007199254740993n, device: 0x100000000000001n })
  expect(rows).toHaveLength(3)
  expect(parse('p42\0\n')).toEqual([])
  expect(parse('p42\0\nf4\0tPIPE\0n->pipe\0\n')).toEqual([{ fd: '4', kind: 'PIPE', path: '->pipe' }])
})
it.each([
  '', 'p42\n', 'p42\0\n' + file().slice(0, -1), 'p41\0\n' + file(),
  file(), 'p42\0\np42\0\n', 'p42\0xextra\0\n',
  'p42\0\n' + file().replace('tREG\0', ''), 'p42\0\n' + file().replace('i9007199254740993\0', ''),
  'p42\0\n' + file().replace('D0x100000000000001', 'Dbad'),
  'p42\0\n' + file().replace('i9007199254740993', 'i-1'),
  'p42\0\n' + file().replace('tREG', 'tREG\0tREG'),
  'p42\0\n' + file() + file('3', '/other', '2'),
  'p42\0\n' + file('3', 'unavailable'),
  'p42\0\n' + file().replace('tREG', 'tUNKNOWN'),
  'p42\0\n' + file('3', '/rollout', '18446744073709551616'),
  'p42\0\n' + file('3', '/' + 'a'.repeat(16_384)),
  'p42\0\n' + file('NOFD'),
  'p42\0\nfNOFD\0nunknown error: Permission denied\0\n',
])('holds malformed, truncated, duplicate or wrong-owner fields %j', text => {
  expect(() => parse(text)).toThrow('identity is held')
})
it('bounds a syntactically valid descriptor pool', () => {
  expect(() => parse('p42\0\n' + Array.from({ length: 4097 }, (_, index) => file(String(index))).join(''))).toThrow('exceeds its limit')
})
it('offers literal and escaped spellings without guessing which file the kernel held', () => {
  expect(descriptorPaths('/café/rollout.jsonl')).toEqual(['/café/rollout.jsonl'])
  expect(descriptorPaths('/caf\\xc3\\xa9/rollout.jsonl')).toEqual(['/caf\\xc3\\xa9/rollout.jsonl', '/café/rollout.jsonl'])
  expect(descriptorPaths('/a\\\\n/rollout.jsonl')).toEqual(['/a\\\\n/rollout.jsonl', '/a\\n/rollout.jsonl'])
  expect(descriptorPaths('/a\\n/rollout.jsonl')).toEqual(['/a\\n/rollout.jsonl', '/a\n/rollout.jsonl'])
  expect(descriptorPaths('/a\\xff/rollout.jsonl')).toEqual(['/a\\xff/rollout.jsonl'])
})
