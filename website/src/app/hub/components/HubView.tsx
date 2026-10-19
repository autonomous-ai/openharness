'use client';
import type { HubViewPage } from '@/lib/community/hubMetrics';
import { useHubView } from './useHubView';

/** Counts a page the server draws (it cannot use the hook itself): draws nothing. */
export function HubView({ page }: { page: HubViewPage }) {
  useHubView(page);
  return null;
}
