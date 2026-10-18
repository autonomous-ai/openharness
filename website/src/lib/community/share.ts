/** Where a harness can be shared, each a page that network opens with the link already in it. */
export type ShareNetwork = 'x' | 'facebook' | 'linkedin';

export const shareNetworks: { id: ShareNetwork; label: string }[] = [
  { id: 'x', label: 'Share on X' },
  { id: 'facebook', label: 'Share on Facebook' },
  { id: 'linkedin', label: 'Share on LinkedIn' },
];

/** The network's own share page for this address; X also takes the title as the post's words. */
export function shareUrl(network: ShareNetwork, url: string, title: string): string {
  const link = encodeURIComponent(url);
  if (network === 'x') return `https://x.com/intent/tweet?text=${encodeURIComponent(title)}&url=${link}`;
  if (network === 'facebook') return `https://www.facebook.com/sharer/sharer.php?u=${link}`;
  return `https://www.linkedin.com/sharing/share-offsite/?url=${link}`;
}
