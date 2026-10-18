'use client';
import { useCallback, useEffect, useState } from 'react';
import { CommunityError } from '@/lib/community/client';
import { readReviewQueue, reviewReport, type ReportedItem } from '@/lib/community/reports';
import { onSessionChange } from '@/lib/community/session';

/** The Hub's reported publications and comments, for a reviewer; `forbidden` for anyone else. */
export function useReviewQueue() {
  const [items, setItems] = useState<ReportedItem[] | null>(null), [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setItems(await readReviewQueue()); setForbidden(false); setError(''); } catch (e) {
      if (e instanceof CommunityError && (e.status === 401 || e.status === 403)) setForbidden(true);
      else setError(e instanceof Error ? e.message : 'The reports could not be loaded.');
    }
  }, []);
  useEffect(() => {
    void load();
    return onSessionChange(() => { void load(); });
  }, [load]);
  async function review(item: ReportedItem, decision: 'restore' | 'remove') {
    setBusy(true); setError('');
    try { await reviewReport(item.targetType, item.targetId, decision); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The review could not be saved.'); }
    finally { setBusy(false); }
  }
  return { items, forbidden, error, busy, load, review };
}
