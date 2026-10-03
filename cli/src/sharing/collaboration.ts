import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

const linkSchema = z.object({
  id: z.string().uuid(), machineId: z.string(), agentId: z.string(),
  name: z.string(), engine: z.string().nullable(), ownerPublicKey: z.string(),
  visibility: z.enum(['private', 'public', 'off']),
  revision: z.number().int().positive(), pending: z.boolean(), error: z.string().nullable(),
})
const commentSchema = z.object({
  id: z.string().uuid(), machineId: z.string(), agentId: z.string(),
  authorId: z.string(), authorName: z.string(), text: z.string(), createdAt: z.string().datetime(),
})
const schema = z.object({ links: z.array(linkSchema), comments: z.array(commentSchema) })
export type HarnessLink = z.infer<typeof linkSchema>
export type CommentAuthor = { id: string; name: string; owner: boolean }
export const linkVisibility = z.enum(['private', 'public', 'off'])
const newComment = z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(4000) })

/** Owner-local authority and discussion history. The relay never stores comment text. */
export class HarnessCollaborationStore {
  private data: z.infer<typeof schema>
  private readonly rates = new Map<string, number[]>()
  constructor(private readonly path: string, private readonly now = () => Date.now()) {
    try { this.data = schema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The harness collaboration file could not be read.')
      this.data = { links: [], comments: [] }
    }
  }
  private save(next: z.infer<typeof schema>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
    renameSync(temp, this.path)
    this.data = next
  }
  links(): HarnessLink[] { return this.data.links.map(l => ({ ...l })) }
  link(machineId: string, agentId: string): HarnessLink | undefined {
    return this.links().find(l => l.machineId === machineId && l.agentId === agentId)
  }
  active(id: string, machineId: string): HarnessLink | undefined {
    return this.links().find(l => l.id === id && l.machineId === machineId && l.visibility !== 'off' && !l.error)
  }
  set(input: Omit<HarnessLink, 'id' | 'revision' | 'pending' | 'error'>): HarnessLink {
    const old = this.link(input.machineId, input.agentId)
    const link = linkSchema.parse({ ...input, id: old?.id ?? randomUUID(), revision: (old?.revision ?? 0) + 1,
      pending: true, error: null })
    this.save({ ...this.data, links: [...this.data.links.filter(l => l.id !== link.id), link] })
    return { ...link }
  }
  published(link: HarnessLink, error: string | null): void {
    this.save({ ...this.data, links: this.data.links.map(l => l.id === link.id && l.revision === link.revision
      ? { ...l, pending: false, error } : l) })
  }
  comments(machineId: string, agentId: string, author: CommentAuthor | null) {
    return this.data.comments.filter(c => c.machineId === machineId && c.agentId === agentId)
      .map(({ id, authorId, authorName, text, createdAt }) => ({ id, authorName, text, createdAt,
        canDelete: !!author && (author.owner || author.id === authorId) }))
  }
  post(machineId: string, agentId: string, author: CommentAuthor | null, input: unknown): string | null {
    if (!author) return 'Sign in to comment.'
    const parsed = newComment.safeParse(input)
    if (!parsed.success) return 'Write a comment between 1 and 4,000 characters.'
    const { id, text } = parsed.data
    const existing = this.data.comments.find(c => c.id === id)
    if (existing) return existing.machineId === machineId && existing.agentId === agentId
      && existing.authorId === author.id && existing.text === text ? null : 'This comment could not be saved. Try again.'
    if (this.comments(machineId, agentId, author).length >= 200) return 'This thread is full. Remove a comment before adding another.'
    const comment = { id, machineId, agentId, authorId: author.id, authorName: author.name,
      text, createdAt: new Date(this.now()).toISOString() }
    const thread = [...this.data.comments.filter(c => c.machineId === machineId && c.agentId === agentId), comment]
    // Bound encoded bytes too: Unicode/JSON escaping can outgrow the encrypted frame limit well
    // before the character/count limits. Leave room for the envelope and per-viewer permissions.
    if (Buffer.byteLength(JSON.stringify(thread)) > 1024 * 1024) return 'This thread is full. Remove a comment before adding another.'
    const now = this.now()
    // Prune inactive authors as well as timestamps so public visitors cannot grow this map forever.
    for (const [key, times] of this.rates) {
      const recent = times.filter(t => t > now - 60_000)
      if (recent.length) this.rates.set(key, recent); else this.rates.delete(key)
    }
    const recent = this.rates.get(author.id) ?? []
    if (recent.length >= 10) return 'Please wait a minute before commenting again.'
    this.save({ ...this.data, comments: [...this.data.comments, comment] })
    this.rates.set(author.id, [...recent, now])
    return null
  }
  remove(machineId: string, agentId: string, author: CommentAuthor | null, id: unknown): string | null {
    const comment = this.data.comments.find(c => c.id === id && c.machineId === machineId && c.agentId === agentId)
    if (!author || (comment && !author.owner && author.id !== comment.authorId)) return 'You can only remove your own comments.'
    if (comment) this.save({ ...this.data, comments: this.data.comments.filter(c => c !== comment) })
    return null
  }
}
