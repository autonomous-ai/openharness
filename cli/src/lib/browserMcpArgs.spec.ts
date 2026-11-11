import { describe, expect, it } from 'vitest'
import { browserMcpArgs } from './browserMcpArgs.js'

describe('browserMcpArgs', () => {
  it('claude args', () => {
    expect(browserMcpArgs('claude', '/opt/harness/bin/harness')).toEqual([
      '--mcp-config={"mcpServers":{"browser":{"type":"stdio","command":"/opt/harness/bin/harness","args":["browser-mcp"]}}}',
    ])
  })

  it('codex args', () => {
    expect(browserMcpArgs('codex', 'C:\\Harness\\harness.exe')).toEqual([
      '-c', 'mcp_servers.browser.command="C:\\\\Harness\\\\harness.exe"',
      '-c', 'mcp_servers.browser.args=["browser-mcp"]',
    ])
  })
})
