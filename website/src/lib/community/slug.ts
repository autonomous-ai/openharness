import { starterHarnesses } from './starters';

/**
 * A publication's address on the web: its title, then the first characters of its id
 * (`/hub/pac-man-neon-maze-chase-fb726d28`). The backend finds it by those characters
 * (`backend/src/lib/communitySlug.ts`), so an edited title keeps old links working; the page then
 * moves to the current one. A starter's id is already a name and is its own address.
 */
export const slugIdChars = 8;
const titleChars = 60;

const isStarter = (id: string) => starterHarnesses.some(item => item.id === id);

/** A title as lowercase ASCII words joined by dashes: "Phở bò!" → "pho-bo". */
export function slugifyTitle(title: string): string {
  const words = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (words.length <= titleChars) return words;
  // Cut at a word, not inside one.
  const cut = words.slice(0, titleChars + 1), end = cut.lastIndexOf('-');
  return (end > 0 ? cut.slice(0, end) : cut.slice(0, titleChars)).replace(/-+$/, '');
}

export function harnessSlug({ id, title }: { id: string; title: string }): string {
  if (isStarter(id)) return id;
  const words = slugifyTitle(title);
  const short = id.slice(0, slugIdChars);
  return words ? `${words}-${short}` : short;
}

export const harnessPath = (harness: { id: string; title: string }): string => `/hub/${harnessSlug(harness)}`;

/** What `/hub/[id]` accepts: a starter, a publication's id, or its slug. */
export const isHarnessAddress = (value: string): boolean => /^[a-z0-9-]{1,80}$/.test(value) && !value.startsWith('-');

/** Whether an address can name a publication (its id, or a slug ending in the id's first characters), as a starter's cannot. */
export const namesPublication = (value: string): boolean => /^[a-f0-9-]{36}$/.test(value) || new RegExp(`(?:^|-)[a-f0-9]{${slugIdChars}}$`).test(value);
