/** Addresses the page loads for itself that the Hub's sandbox serves: none, apart from these. */
const inline = /^(?:data:|blob:|#|about:|javascript:)/i;

const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find(value => value !== undefined)?.trim();

/**
 * Files and addresses an output page loads that the published preview cannot reach: the sandbox
 * serves no other file and blocks the network, so each one is missing for readers.
 */
export function outsideResources(html: string): string[] {
  const found = new Set<string>();
  const add = (value: string | undefined) => { if (value && !inline.test(value)) found.add(value); };
  for (const [tag] of html.matchAll(/<(?:script|img|iframe|source|video|audio|embed|track)\b[^>]*>/gi)) add(attribute(tag, 'src'));
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/\brel\s*=\s*["']?(?:stylesheet|preload|modulepreload)\b/i.test(tag)) add(attribute(tag, 'href'));
  }
  for (const [, value] of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(value.trim());
  for (const [, value] of html.matchAll(/@import\s+["']([^"']+)["']/gi)) add(value);
  return [...found];
}
