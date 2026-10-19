'use client';
import { useEffect, useRef } from 'react';
import { countHub, countHubEntry, flushHub } from '@/lib/community/hubMeasure';
import { dwellBucket, type HubViewPage } from '@/lib/community/hubMetrics';
import { useSignedIn } from './useSignedIn';

/** A Hub page drawn, once per navigation, by a visitor or a member, as soon as it is known which; the first of a tab's visit also says where it came from. */
export function useHubView(page: HubViewPage) {
  const signedIn = useSignedIn(), counted = useRef(false);
  useEffect(() => {
    if (signedIn === null || counted.current) return;
    counted.current = true;
    countHub(`hub_view_${page}_${signedIn ? 'member' : 'visitor'}`);
    countHubEntry();
  }, [page, signedIn]);
}

/** How long a harness page stayed in view (hidden time not counted), counted once as it is left: a navigation, or the tab closing. */
export function useHarnessDwell() {
  useEffect(() => {
    let shown = 0, since: number | null = document.visibilityState === 'visible' ? performance.now() : null, done = false;
    const pause = () => { if (since !== null) { shown += performance.now() - since; since = null; } };
    const visibility = () => { if (document.visibilityState === 'visible') since ??= performance.now(); else pause(); };
    const finish = () => {
      if (done) return;
      done = true; pause(); countHub(dwellBucket(shown));
    };
    // The tab closing: counted, then sent with the rest before the page goes.
    const leave = () => { finish(); flushHub(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', leave);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', leave); finish(); };
  }, []);
}
