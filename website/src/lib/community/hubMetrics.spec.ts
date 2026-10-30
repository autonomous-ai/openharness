// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as backend from '../../../../backend/src/lib/hubMetricsContract';
import { dwellBucket, entrySource, hubActions, hubDwell, hubEntrySources, hubReportMaxValue, hubSharedOpens, hubViewPages } from './hubMetrics';

describe('the Hub usage counters', () => {
  it('are the ones the backend accepts', () => {
    expect([...hubViewPages]).toEqual([...backend.HUB_VIEW_PAGES]);
    expect([...hubEntrySources]).toEqual([...backend.HUB_ENTRY_SOURCES]);
    expect([...hubDwell]).toEqual([...backend.HUB_DWELL]);
    expect([...hubActions]).toEqual([...backend.HUB_ACTIONS]);
    expect([...hubSharedOpens]).toEqual([...backend.HUB_SHARED_OPENS]);
    expect(hubReportMaxValue).toBe(backend.HUB_REPORT_MAX_VALUE);
  });
  it('class a visit by its referrer’s host alone', () => {
    const own = 'harness.autonomous.ai';
    expect(entrySource('', own)).toBe('direct');
    expect(entrySource('https://harness.autonomous.ai/desktop', own)).toBe('internal');
    expect(entrySource('https://www.google.com/', own)).toBe('search');
    expect(entrySource('https://duckduckgo.com/?q=harness', own)).toBe('search');
    expect(entrySource('https://t.co/abc', own)).toBe('social');
    expect(entrySource('https://m.facebook.com/', own)).toBe('social');
    expect(entrySource('https://news.ycombinator.com/item?id=1', own)).toBe('social');
    expect(entrySource('https://example.dev/post', own)).toBe('other');
    expect(entrySource('not a url', own)).toBe('other');
    // A host that only ends like one is not it.
    expect(entrySource('https://notx.com/', own)).toBe('other');
  });
  it('bucket a harness page’s time in view as the backend does', () => {
    expect(dwellBucket(9_999)).toBe('hub_harness_dwell_under_10s');
    expect(dwellBucket(10_000)).toBe('hub_harness_dwell_10s_to_1m');
    expect(dwellBucket(60_000)).toBe('hub_harness_dwell_over_1m');
  });
});
