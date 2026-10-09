/** The longest feed search the backend accepts (`q` on GET /api/community/harnesses). */
export const searchMaxChars = 80;

/** The search a page was opened with, from its `?q=`. */
export async function searchFromParams(searchParams: Promise<{ q?: string | string[] }>): Promise<string> {
  const { q } = await searchParams;
  return typeof q === 'string' ? q.trim().slice(0, searchMaxChars) : '';
}
