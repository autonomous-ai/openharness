import { describe, expect, it } from 'vitest';
import { outsideResources } from './outputCheck';

describe('output check', () => {
  it('names what an output page loads from elsewhere', () => {
    const html = `<link rel="stylesheet" href="style.css"><link rel="icon" href="favicon.ico">
      <script type="module" src='./app.js'></script><img src=https://cdn.example/logo.png>
      <style>@import "fonts.css"; body { background: url(bg.png) }</style><a href="other.html">More</a>`;
    expect(outsideResources(html)).toEqual(['./app.js', 'https://cdn.example/logo.png', 'style.css', 'bg.png', 'fonts.css']);
  });
  it('accepts a page that carries everything itself', () => {
    expect(outsideResources('<style>i{background:url("data:image/png;base64,AA==")}</style><img src="data:image/png;base64,AA=="><script>go()</script><a href="#top">Top</a>')).toEqual([]);
  });
});
