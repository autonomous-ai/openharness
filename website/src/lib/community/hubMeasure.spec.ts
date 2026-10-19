import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countHub, countHubEntry, flushHub } from './hubMeasure';

const sent = () => (vi.mocked(fetch).mock.calls as [string, RequestInit][]).map(([url, init]) => ({ url, init, report: JSON.parse(String(init.body)) }));
const setNavigator = (key: string, value: unknown) => Object.defineProperty(navigator, key, { value, configurable: true });

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 }))); localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { flushHub(); vi.unstubAllGlobals(); setNavigator('globalPrivacyControl', undefined); setNavigator('doNotTrack', null); });

describe('Hub measurement', () => {
  it('adds up a day’s counts and sends them once, without cookies', () => {
    countHub('hub_like'); countHub('hub_like'); countHub('hub_share_x');
    flushHub();
    const [request] = sent();
    expect(request.url).toBe('/api/hub-usage');
    expect(request.init.credentials).toBe('omit');
    expect(request.init.keepalive).toBe(true);
    expect(request.report).toMatchObject({ schemaVersion: 1, day: new Date().toISOString().slice(0, 10), counters: { hub_like: 2, hub_share_x: 1 } });
    expect(Object.keys(request.report).sort()).toEqual(['counters', 'day', 'id', 'schemaVersion']);
    flushHub();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('passes a sign-in only so the server can leave out a reader who turned sharing off', () => {
    localStorage.setItem('harness.web.v1.auth_access_token', 'token');
    countHub('hub_follow'); flushHub();
    expect((sent()[0].init.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });
  it('counts nothing under Global Privacy Control, Do Not Track, or for a staging account', () => {
    setNavigator('globalPrivacyControl', true); countHub('hub_like'); flushHub();
    setNavigator('globalPrivacyControl', undefined); setNavigator('doNotTrack', '1'); countHub('hub_like'); flushHub();
    setNavigator('doNotTrack', null); localStorage.setItem('harness.web.v1.auth_autonomous_env', 'stag'); countHub('hub_like'); flushHub();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('says where a tab’s visit came from once, never the referrer itself', () => {
    countHubEntry(); countHubEntry(); flushHub();
    const { report } = sent()[0];
    expect(report.counters).toEqual({ hub_entry_direct: 1 });
    expect(JSON.stringify(report)).not.toContain('http');
  });
  it('sends on its own after a while', () => {
    vi.useFakeTimers();
    countHub('hub_card_open');
    vi.advanceTimersByTime(60_000);
    expect(sent()[0].report.counters).toEqual({ hub_card_open: 1 });
    vi.useRealTimers();
  });
});
