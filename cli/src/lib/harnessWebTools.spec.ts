import { describe, expect, it } from 'vitest'
import { HARNESS_MCP_SERVER_NAME, harnessWebTool, harnessWebToolKind, webReadUrl } from './harnessWebTools.js'

describe('harnessWebTool', () => {
  it('derives the tool names from the server name, so a rename cannot leave the cards behind', () => {
    expect(harnessWebToolKind(`mcp__${HARNESS_MCP_SERVER_NAME}__web_search`)).toBe('WebSearch')
    expect(harnessWebToolKind(`mcp__${HARNESS_MCP_SERVER_NAME}__web_read`)).toBe('WebFetch')
  })

  it('answers null for every other tool, MCP or not', () => {
    for (const name of ['WebSearch', 'mcp__github__get_issue', 'mcp__grid-web__web_search', 'web_search', '', undefined]) {
      expect(harnessWebToolKind(name), String(name)).toBeNull()
      expect(harnessWebTool(name, { query: 'x' }), String(name)).toBeNull()
    }
  })

  it('keeps web_search input as it is — the card already reads `query`', () => {
    expect(harnessWebTool('mcp__harness__web_search', { query: 'BTC price', num_results: 5 }))
      .toEqual({ tool: 'WebSearch', input: { query: 'BTC price', num_results: 5 } })
  })

  it('gives web_read the `url` the WebFetch card reads, keeping `urls` beside it', () => {
    expect(harnessWebTool('mcp__harness__web_read', { urls: ['https://a.example/', 'https://b.example/'], max_chars: 6000 }))
      .toEqual({ tool: 'WebFetch', input: { urls: ['https://a.example/', 'https://b.example/'], max_chars: 6000, url: 'https://a.example/, https://b.example/' } })
  })

  it('leaves a `url` that is already there alone', () => {
    // A future server, or a replay, may already speak the card's shape; nothing here may overwrite it.
    expect(harnessWebTool('mcp__harness__web_read', { url: 'https://c.example/', urls: ['https://a.example/'] }))
      .toEqual({ tool: 'WebFetch', input: { url: 'https://c.example/', urls: ['https://a.example/'] } })
  })

  it('adds no `url` when the list holds nothing usable', () => {
    expect(harnessWebTool('mcp__harness__web_read', { urls: ['', '  ', 42] }))
      .toEqual({ tool: 'WebFetch', input: { urls: ['', '  ', 42] } })
    expect(harnessWebTool('mcp__harness__web_read', { urls: 'https://a.example/' }))
      .toEqual({ tool: 'WebFetch', input: { urls: 'https://a.example/' } })
  })

  it('tolerates an input that is not an object, and never mutates the one it is given', () => {
    expect(harnessWebTool('mcp__harness__web_search', undefined)).toEqual({ tool: 'WebSearch', input: {} })
    expect(harnessWebTool('mcp__harness__web_read', ['https://a.example/'])).toEqual({ tool: 'WebFetch', input: {} })
    const given = { urls: ['https://a.example/'] }
    harnessWebTool('mcp__harness__web_read', given)
    expect(given).toEqual({ urls: ['https://a.example/'] })
  })
})

describe('webReadUrl', () => {
  it('joins the usable strings and drops the rest', () => {
    expect(webReadUrl(['https://a.example/', '', null, 7, ' https://b.example/'])).toBe('https://a.example/,  https://b.example/')
    expect(webReadUrl([])).toBe('')
  })
})
