import { createHash } from 'node:crypto'

export const inputHash = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex')
export interface ResultEvidence {
  evidenceId: string
  engineTurnId?: string
  inputs: string[] // matched delivery IDs, never session-wide outstanding inputs
  outcome: 'completed' | 'failed' | 'cancelled'
  fullText: string
}
type Json = Record<string, any>
interface Node { parent?: string; input?: string | null; root: boolean; text?: string; messageId?: string; bytes: number }
interface Turn { members: Array<string | null>; bytes: number }
interface State { nodes: Map<string, Node>; seen: Set<string>; turns: Map<string, Turn>; bytes: number; records: number }
const MAX_BYTES = 16 * 1024 * 1024, MAX_RECORDS = 65_536
const bytes = (value: string | null | undefined): number => value ? Buffer.byteLength(value) : 0
/** Device-only transcript observer. Neither scheduling nor shared normalizers are changed.
 * Claude: walk the final answer's parentUuid chain to its human root, including queued_command
 * attachments on that exact branch. Codex: use explicit per-message engine turn IDs only.
 */
export class DeviceResultEvidence {
  private sessions = new Map<string, State>()
  private retainedBytes = 0
  private retainedRecords = 0
  constructor(private readonly consume: (agentId: string, text: string, timestamp: number) => string | null,
    private readonly result: (agentId: string, evidence: ResultEvidence) => void,
    private readonly uncertain: (agentId: string, inputs: string[]) => void,
    private readonly overflow: (agentId: string) => void) {}
  forget(agentId: string): void {
    const state = this.sessions.get(agentId)
    if (!state) return
    this.release(state, state.bytes, state.records)
    this.sessions.delete(agentId)
  }
  private release(state: State, size: number, records: number): void {
    state.bytes -= size; state.records -= records
    this.retainedBytes -= size; this.retainedRecords -= records
  }
  private retain(agent: string, state: State, size: number, records: number): boolean {
    if (this.retainedBytes + size > MAX_BYTES || this.retainedRecords + records > MAX_RECORDS) {
      this.forget(agent); this.overflow(agent)
      return false
    }
    state.bytes += size; state.records += records
    this.retainedBytes += size; this.retainedRecords += records
    return true
  }
  ingest(agentId: string, engine: string, line: string): void {
    if (engine !== 'claude' && engine !== 'codex') return
    let row: Json
    try { row = JSON.parse(line) } catch { return }
    if (!row || typeof row !== 'object' || row.isSidechain === true) return
    let s = this.sessions.get(agentId)
    if (!s) { s = { nodes: new Map(), seen: new Set(), turns: new Map(), bytes: 0, records: 0 }; this.sessions.set(agentId, s) }
    if (engine === 'claude') this.claude(agentId, s, row)
    else this.codex(agentId, s, row)
  }
  private claude(agent: string, s: State, row: Json): void {
    if (typeof row.uuid !== 'string' || !row.uuid || s.nodes.has(row.uuid)) return
    const message = row.message
    const attachment = row.attachment
    const blocks: Json[] = Array.isArray(message?.content) ? message.content : []
    const text = typeof message?.content === 'string' ? message.content
      : blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
    const root = row.type === 'user' && row.isMeta !== true && !!text && !blocks.some(b => b?.type === 'tool_result')
    const queued = row.type === 'attachment' && attachment?.type === 'queued_command'
      && attachment.commandMode === 'prompt' && attachment.origin?.kind === 'human' && typeof attachment.prompt === 'string'
    const node: Node = { parent: typeof row.parentUuid === 'string' ? row.parentUuid : undefined, root, bytes: 0 }
    if (root || queued) node.input = this.consume(agent, root ? text : attachment.prompt, Date.parse(row.timestamp))
    if (row.type === 'assistant') { node.text = text; node.messageId = typeof message?.id === 'string' ? message.id : undefined }
    // Missing ancestry after eviction fails closed, never infers membership from time/session.
    if (s.nodes.size === 8192) {
      const first = s.nodes.keys().next().value!
      this.release(s, s.nodes.get(first)!.bytes, 1); s.nodes.delete(first)
    }
    node.bytes = bytes(row.uuid) + bytes(node.parent) + bytes(node.input) + bytes(node.text) + bytes(node.messageId)
    if (!this.retain(agent, s, node.bytes, 1)) return
    s.nodes.set(row.uuid, node)
    if (row.type !== 'assistant' || message?.stop_reason !== 'end_turn' || blocks.some(b => b?.type === 'tool_use')) return
    const members: Array<string | null> = []
    const final: string[] = []
    let cursor: Node | undefined = node, complete = false
    const visited = new Set<Node>()
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor)
      if ('input' in cursor) members.unshift(cursor.input ?? null)
      if (cursor.messageId && cursor.messageId === node.messageId && cursor.text) final.unshift(cursor.text)
      if (cursor.root) { complete = true; break }
      cursor = cursor.parent ? s.nodes.get(cursor.parent) : undefined
    }
    const ids = members.filter((id): id is string => id !== null)
    const fullText = final.join('\n\n')
    if (!complete || members.includes(null) || !ids.length || !fullText.trim()) { this.uncertain(agent, ids); return }
    this.result(agent, { evidenceId: `claude:${row.uuid}`, inputs: [...new Set(ids)], outcome: 'completed', fullText })
  }
  private codex(agent: string, s: State, row: Json): void {
    const p = row.payload
    if (!p || typeof p !== 'object') return
    const key = typeof row.ordinal === 'number' ? `ordinal:${row.ordinal}` : typeof p.id === 'string' ? `item:${p.id}`
      : p.type === 'task_complete' && typeof p.turn_id === 'string' ? `complete:${p.turn_id}` : undefined
    if (!key || s.seen.has(key)) return
    if (s.seen.size === 16384) {
      const first = s.seen.values().next().value!
      this.release(s, bytes(first), 1); s.seen.delete(first)
    }
    if (!this.retain(agent, s, bytes(key), 1)) return
    s.seen.add(key)
    if (row.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const metadata = p.internal_chat_message_metadata_passthrough
      const turn = metadata?.turn_id
      // Older rollouts lacking explicit message-to-turn mapping are deliberately unsupported.
      if (typeof turn !== 'string' || !turn) return
      const kinds = metadata.content_item_kinds
      if (!Array.isArray(kinds) || !kinds.includes('user.text')) return // environment/AGENTS context is not an input
      const blocks: Json[] = Array.isArray(p.content) ? p.content.filter((_: unknown, i: number) => kinds[i] === 'user.text') : []
      const text = blocks.filter(b => b?.type === 'input_text' && typeof b.text === 'string').map(b => b.text).join('\n')
      const member = this.consume(agent, text, Date.parse(row.timestamp))
      let inputs = s.turns.get(turn)
      if (!inputs && s.turns.size === 256) {
        const first = s.turns.keys().next().value!, old = s.turns.get(first)!
        this.release(s, old.bytes, old.members.length + 1); s.turns.delete(first)
        this.uncertain(agent, old.members.filter((id): id is string => id !== null))
      }
      const size = bytes(member) + (inputs ? 0 : bytes(turn))
      // Null membership still occupies a record; unsupported inputs cannot grow a zero-byte list.
      if (!this.retain(agent, s, size, inputs ? 1 : 2)) return
      if (!inputs) { inputs = { members: [], bytes: 0 }; s.turns.set(turn, inputs) }
      inputs.members.push(member); inputs.bytes += size
    }
    if (row.type !== 'event_msg' || !['task_complete', 'turn_aborted'].includes(p.type) || typeof p.turn_id !== 'string') return
    const turn = s.turns.get(p.turn_id), members = turn?.members ?? []
    if (turn) { this.release(s, turn.bytes, members.length + 1); s.turns.delete(p.turn_id) }
    const ids = members.filter((id): id is string => id !== null)
    const fullText = p.last_agent_message
    if (members.includes(null) || !ids.length || typeof fullText !== 'string' || !fullText.trim() || p.type === 'turn_aborted' || p.error) {
      this.uncertain(agent, ids); return
    }
    this.result(agent, { evidenceId: `codex:${p.turn_id}`, engineTurnId: p.turn_id, inputs: [...new Set(ids)], outcome: 'completed', fullText })
  }
}
