#!/usr/bin/env node
/**
 * e2e_calc — the smallest MCP server that can prove "the tool still uses MCP after a switch".
 *
 * stdio transport, newline-delimited JSON-RPC, two tools: add(a, b) and sub(a, b). Every call is
 * appended to the log file given as argv[2] (`<ts> <tool> <a> <b> = <result>`), so the e2e has hard
 * evidence the model went THROUGH the server rather than doing the arithmetic in its head.
 * No SDK on purpose: nothing to install in the scratch workspace the test agent runs in.
 */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logFile = process.argv[2]
const TOOLS = [
  { name: 'add', description: 'Add two numbers: a + b', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'sub', description: 'Subtract two numbers: a - b', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
]

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function log(line) {
  if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let req
  try { req = JSON.parse(line) } catch { return }
  const { id, method, params } = req
  if (id === undefined) return // notification (notifications/initialized, …)
  switch (method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'e2e_calc', version: '1.0.0' } } })
      return
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} })
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      return
    case 'tools/call': {
      const name = params?.name
      const a = Number(params?.arguments?.a)
      const b = Number(params?.arguments?.b)
      if ((name !== 'add' && name !== 'sub') || Number.isNaN(a) || Number.isNaN(b)) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: unknown tool or bad arguments (${name})` }], isError: true } })
        return
      }
      const result = name === 'add' ? a + b : a - b
      log(`${name} ${a} ${b} = ${result}`)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(result) }] } })
      return
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  }
})
