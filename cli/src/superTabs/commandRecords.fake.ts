// Specs' stand-in for the backend's record of who made each GitHub comment (backend superTabs/githubComments.ts).
type Json = Record<string, unknown>

/** Verdicts made by command, as the backend records them (githubMerge.ts VerdictRecords): each comment is given a GitHub id as
 *  it is served, and one in the command's form ("Juno, 14:20: ...") is recorded as that name's, unless it is marked `typed` (typed
 *  by hand) or is a review (the command posts comments). */
export function commandRecords() {
  const byId = new Map<number, Json>(), ids = new WeakMap<Json, number>()
  const served = (comment: Json): Json => {
    if (comment.id !== undefined) { byId.set(Number(comment.id), comment); return comment }
    const id = ids.get(comment) ?? 1_000 + byId.size
    ids.set(comment, id)
    byId.set(id, comment)
    return { ...comment, id }
  }
  const signer = (comment: Json) => comment.typed === true ? undefined : /^\**([^,:(*@＠﹫]+?)\**, \d\d:\d\d\b/.exec(String(comment.body ?? ''))?.[1]
  const authors = async (_project: unknown, asked: string[]) => Object.fromEntries(asked.flatMap(id => {
    const name = signer(byId.get(Number(id.slice('issue:'.length))) ?? {})
    return name ? [[id, { name }]] : []
  }))
  return { served, authors }
}
