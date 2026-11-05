// iOS Safari pans the page when the keyboard comes up again after it was dismissed: the visual
// viewport (or the document) scrolls, the app's fixed canvas leaves the screen, and the top bar and
// the message box are out of sight above blank space. desktop/web/index.html puts the page back at
// the top. This runs that inline script against a fake window.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const page = readFileSync(join(process.cwd(), '..', 'desktop', 'web', 'index.html'), 'utf8');
const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((body) => body.includes('maximum-scale=1.0'));

const iPhone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
const desktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

function load({ userAgent = iPhone, platform = 'iPhone', viewport = {} } = {}) {
  const windowListeners = {};
  const viewportListeners = {};
  const scrolls = [];
  const visualViewport = {
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
    ...viewport,
    addEventListener(type, listener) { (viewportListeners[type] ||= []).push(listener); },
  };
  const win = {
    scrollX: 0,
    scrollY: 0,
    visualViewport: viewport === null ? undefined : visualViewport,
    addEventListener(type, listener) { (windowListeners[type] ||= []).push(listener); },
    scrollTo(x, y) { scrolls.push([x, y]); },
  };
  const metas = [];
  runInNewContext(script, {
    window: win,
    navigator: { userAgent, platform, maxTouchPoints: platform === 'iPhone' ? 5 : 0 },
    document: {
      head: {},
      querySelectorAll: () => metas,
    },
    MutationObserver: class { observe() {} },
  });
  return {
    win,
    visualViewport,
    scrolls,
    fire(target, type) {
      const listeners = target === win ? windowListeners : viewportListeners;
      (listeners[type] || []).forEach((listener) => listener({ type }));
    },
    listening: () => Object.keys(windowListeners).length + Object.keys(viewportListeners).length,
  };
}

describe('iOS Safari keyboard pan', () => {
  it('puts the page back at the top when the visual viewport is panned down', () => {
    const page = load();
    page.visualViewport.offsetTop = 336;
    page.fire(page.visualViewport, 'scroll');
    expect(page.scrolls).toEqual([[0, 0]]);
  });

  it('puts the page back at the top when the keyboard resizes the viewport while it is panned', () => {
    const page = load();
    page.visualViewport.offsetTop = 336;
    page.fire(page.visualViewport, 'resize');
    expect(page.scrolls).toEqual([[0, 0]]);
  });

  it('puts the page back at the top when the document itself scrolls', () => {
    const page = load();
    page.win.scrollY = 336;
    page.fire(page.win, 'scroll');
    expect(page.scrolls).toEqual([[0, 0]]);
  });

  it('leaves a page that is already at the top alone', () => {
    const page = load();
    page.fire(page.visualViewport, 'scroll');
    page.fire(page.visualViewport, 'resize');
    page.fire(page.win, 'scroll');
    expect(page.scrolls).toEqual([]);
  });

  it('leaves a page the visitor pinch-zoomed alone', () => {
    const page = load({ viewport: { scale: 2.5, offsetTop: 120, offsetLeft: 40 } });
    page.fire(page.visualViewport, 'scroll');
    page.win.scrollY = 120;
    page.fire(page.win, 'scroll');
    expect(page.scrolls).toEqual([]);
  });

  it('does nothing on desktop browsers and Android Chrome', () => {
    for (const env of [
      { userAgent: desktop, platform: 'MacIntel' },
      { userAgent: android, platform: 'Linux armv8l' },
    ]) {
      const page = load(env);
      expect(page.listening()).toBe(0);
    }
  });

  it('starts without the visual viewport API', () => {
    const page = load({ viewport: null });
    page.win.scrollY = 50;
    page.fire(page.win, 'scroll');
    expect(page.scrolls).toEqual([[0, 0]]);
  });
});
