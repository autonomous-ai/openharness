/** Existing device wire data only. No collection state, rendering or background work. */
export const COMPANION_SPECIES = ['tim', 'gnu', 'lynx', 'mutt', 'yak', 'gopher', 'bug', 'tux', 'auk', 'beastie'] as const
export interface CompanionIdentity {
  id: string
  uid: string
  seed: number
  name: string
  version: '0.1' | '1.0' | '2.0'
  colour: number
  mark: number
}
export function readCompanionIdentity(value: unknown): CompanionIdentity | null {
  if (!value || typeof value !== 'object') return null
  const d = value as Record<string, unknown>
  if (typeof d.id !== 'string' || !COMPANION_SPECIES.includes(d.id as typeof COMPANION_SPECIES[number]) ||
      typeof d.uid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(d.uid) ||
      typeof d.name !== 'string' || !/^[\x20-\x7e]{1,24}$/.test(d.name) ||
      !['0.1','1.0','2.0'].includes(d.version as string) ||
      !Number.isInteger(d.seed) || (d.seed as number)<0 || (d.seed as number)>0xffffffff ||
      !Number.isInteger(d.colour) || (d.colour as number)<-1 || (d.colour as number)>5 ||
      !Number.isInteger(d.mark) || (d.mark as number)<0 || (d.mark as number)>4) return null
  return {id:d.id,uid:d.uid,name:d.name,version:d.version as CompanionIdentity['version'],seed:d.seed as number,colour:d.colour as number,mark:d.mark as number}
}
