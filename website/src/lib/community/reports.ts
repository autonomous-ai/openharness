import { communityRequest } from './client';

/** The reasons a reader picks from, as backend `communityReportReasons` lists them (contract.spec.ts checks). */
export const reportReasons = [
  ['spam', 'Spam'], ['harassment', 'Harassment or hate'], ['sexual', 'Sexual content'], ['violence', 'Violence'],
  ['private_information', 'Private information'], ['harmful_code', 'Harmful code'], ['other', 'Something else'],
] as const;
export type ReportReason = typeof reportReasons[number][0];
export type ReportTarget = 'harness' | 'comment';

/** Reports a publication or comment: hidden from this reader at once, and from everyone after three readers. */
export const postReport = (targetType: ReportTarget, targetId: string, reason: ReportReason) =>
  communityRequest('reports', { method: 'POST', body: { targetType, targetId, reason } });

/** One reported publication or comment, as a reviewer sees it. `text` is its title or words, null once gone. */
export type ReportedItem = {
  targetType: ReportTarget; targetId: string; harnessId: string; reports: number; lastReportedAt: string;
  reasons: Partial<Record<ReportReason, number>>; state: 'visible' | 'hidden' | 'restored' | 'removed'; text: string | null; authorName: string | null;
};

export const readReviewQueue = async () => (await communityRequest<{ reports: ReportedItem[] }>('reports')).reports;

export const reviewReport = (targetType: ReportTarget, targetId: string, decision: 'restore' | 'remove') =>
  communityRequest('reports/review', { method: 'POST', body: { targetType, targetId, decision } });
