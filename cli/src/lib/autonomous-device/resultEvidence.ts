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
interface Node { parent?: string; input?: string | null; root: boolean; text?: string; messageId?: string }
interface State { nodes: Map<string, Node>; seen: Set<string>; turns: Map<string, Array<string | null>> }
/** Device-only transcript observer. Neither scheduling nor shared normalizers are changed.
 * Claude: walk the final answer's parentUuid chain to its human root, including queued_command
 * attachments on that exact branch. Codex: use explicit per-message engine turn IDs only.
 */
export class DeviceResultEvidence {
  private sessions = new Map<string, State>()
  constructor(private readonly consume: (agentId: string, text: string, timestamp: number) => string | null,
    private readonly result: (agentId: string, evidence: ResultEvidence) => void,
    private readonly uncertain: (agentId: string, inputs: string[]) => void) {}
  forget(agentId: string): void { this.sessions.delete(agentId) }
  ingest(agentId: string, engine: string, line: string): void {
    if (engine !== 'claude' && engine !== 'codex') return
    let row: Json
    try { row = JSON.parse(line) } catch { return }
    if (!row || typeof row !== 'object' || row.isSidechain === true) return
    let s = this.sessions.get(agentId)
    if (!s) { s = { nodes: new Map(), seen: new Set(), turns: new Map() }; this.sessions.set(agentId, s) }
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
    const node: Node = { parent: typeof row.parentUuid === 'string' ? row.parentUuid : undefined, root }
    if (root || queued) node.input = this.consume(agent, root ? text : attachment.prompt, Date.parse(row.timestamp))
    if (row.type === 'assistant') { node.text = text; node.messageId = message?.id }
    s.nodes.set(row.uuid, node)
    // Missing ancestry after eviction fails closed, never infers membership from time/session.
    if (s.nodes.size > 8192) s.nodes.delete(s.nodes.keys().next().value!)
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
    s.seen.add(key)
    if (s.seen.size > 16384) s.seen.delete(s.seen.values().next().value!)
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
      const inputs = s.turns.get(turn) ?? []
      inputs.push(member); s.turns.set(turn, inputs)
      if (s.turns.size > 256) { const first = s.turns.keys().next().value!; this.uncertain(agent, (s.turns.get(first) ?? []).filter((id): id is string => id !== null)); s.turns.delete(first) }
    }
    if (row.type !== 'event_msg' || !['task_complete', 'turn_aborted'].includes(p.type) || typeof p.turn_id !== 'string') return
    const members = s.turns.get(p.turn_id) ?? []
    s.turns.delete(p.turn_id)
    const ids = members.filter((id): id is string => id !== null)
    const fullText = p.last_agent_message
    if (members.includes(null) || !ids.length || typeof fullText !== 'string' || !fullText.trim() || p.type === 'turn_aborted' || p.error) {
      this.uncertain(agent, ids); return
    }
    this.result(agent, { evidenceId: `codex:${p.turn_id}`, engineTurnId: p.turn_id, inputs: [...new Set(ids)], outcome: 'completed', fullText })
  }
}
