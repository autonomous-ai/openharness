/**
 * The store never keeps a folder path: a project is a hash of its resolved path, and its name is only the
 * folder's own, printable and short.
 */
import { describe, expect, it } from 'vitest'
import { contentHash, projectHash, projectName } from './types.js'

describe('projectHash', () => {
  it('16 hex characters of the resolved path; nothing for no folder', () => {
    expect(projectHash('/work/api')).toMatch(/^[0-9a-f]{16}$/)
    expect(projectHash('/work/api/')).toBe(projectHash('/work/api'))
    expect(projectHash('/work/x/../api')).toBe(projectHash('/work/api'))
    expect(projectHash('/work/web')).not.toBe(projectHash('/work/api'))
    expect(projectHash(null)).toBeNull()
    expect(projectHash(undefined)).toBeNull()
    expect(projectHash('')).toBeNull()
  })
})

describe('projectName', () => {
  it('the folder\'s own name, never its path; odd characters become dashes; at most 40', () => {
    expect(projectName('/Users/someone/code/api')).toBe('api')
    expect(projectName('/work/my project (old)')).toBe('my-project-old-')
    expect(projectName(`/work/${'x'.repeat(60)}`)).toHaveLength(40)
    expect(projectName('/work/a/../b')).toBe('b')
  })
  it('nothing for no folder, or the root', () => {
    expect(projectName(null)).toBeNull()
    expect(projectName('')).toBeNull()
    expect(projectName('/')).toBeNull()
  })
})

describe('contentHash', () => {
  it('24 hex characters, stable, and different for different values', () => {
    expect(contentHash(['skill', 'x', 'body'])).toMatch(/^[0-9a-f]{24}$/)
    expect(contentHash(['skill', 'x', 'body'])).toBe(contentHash(['skill', 'x', 'body']))
    expect(contentHash(['skill', 'x', 'body'])).not.toBe(contentHash(['skill', 'x', 'body.']))
  })
})
