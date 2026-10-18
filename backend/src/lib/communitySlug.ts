import { prisma } from './prisma.js'

/**
 * The website addresses a publication as its title and the first characters of its id
 * (`pac-man-neon-maze-chase-fb726d28`, website `lib/community/slug.ts`). The title is for readers;
 * the characters find it, so an edited title leaves earlier links working.
 */
const slugIdChars = 8
const slugPattern = new RegExp(`(?:^|-)([a-f0-9]{${slugIdChars}})$`)
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/** The id start a slug names, or null for an id (or a starter) used as it is. */
export function slugIdPrefix(address: string): string | null {
  if (uuidPattern.test(address)) return null
  return address.match(slugPattern)?.[1] ?? null
}

/**
 * The publication id an address names: a slug finds the publication whose id starts with its
 * characters. Two sharing them are told apart by the rest of the slug, the title (the website may
 * have shortened it, so it is the start of theirs); an edited title still finds the oldest.
 */
export async function resolvePublicationId(address: string, autonomousEnv: string): Promise<string> {
  const prefix = slugIdPrefix(address)
  if (!prefix) return address
  const rows = await prisma.communityHarness.findMany({
    where: { autonomousEnv, deletedAt: null, id: { startsWith: prefix } },
    select: { id: true, title: true }, orderBy: { createdAt: 'asc' }, take: 5,
  })
  const words = address.slice(0, -prefix.length).replace(/-$/, '')
  const named = rows.find(row => slugWords(row.title).startsWith(words)) ?? rows[0]
  return named?.id ?? address
}

/** The words a title makes in a slug, as the website writes them. */
function slugWords(title: string): string {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
