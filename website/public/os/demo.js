/* A scripted product illustration. No framework, network requests, or live agent. */
(() => {
  'use strict';
  const demo = document.querySelector('#os-demo');
  const poster = document.querySelector('#demo-poster');
  const button = document.querySelector('#demo-motion');
  const shortcut = document.querySelector('#demo-shortcut');
  if (!demo || !poster || !button || !shortcut) return;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const typed = [...demo.querySelectorAll('[data-type]')].map(node => ({
    node, text: node.textContent, start: Number(node.dataset.type),
    speed: Number(node.dataset.speed), count: -1,
  }));
  const lines = [...demo.querySelectorAll('[data-at]')];
  const carets = [...demo.querySelectorAll('[data-caret]')];
  let elapsed = motion.matches ? 10000 : 0;
  let playing = !motion.matches;
  let previous = performance.now();
  let timer;

  function render() {
    const scene = elapsed < 1200 ? 'boot' : elapsed >= 11900 && elapsed < 17100 ? 'browser' : 'work';
    if (demo.dataset.scene !== scene) demo.dataset.scene = scene;
    for (const item of typed) {
      const count = Math.max(0, Math.min(item.text.length, Math.floor((elapsed - item.start) / item.speed)));
      if (item.count !== count) {
        item.node.textContent = item.text.slice(0, count);
        item.count = count;
      }
    }
    for (const node of lines) node.classList.toggle('visible', elapsed >= Number(node.dataset.at));
    for (const node of carets) {
      const [start, end] = node.dataset.caret.split(':').map(Number);
      node.classList.toggle('caret-active', elapsed >= start && elapsed < end);
    }
    shortcut.hidden = !(elapsed >= 10800 && elapsed < 12600 || elapsed >= 16000 && elapsed < 17800);
    demo.classList.toggle('motion-paused', !playing || document.hidden);
    const label = playing ? 'Pause animation' : 'Play animation';
    button.textContent = playing ? 'Ⅱ' : '▶';
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  function tick() {
    const now = performance.now();
    elapsed += Math.min(now - previous, 160);
    previous = now;
    // Only the first cycle boots. Subsequent cycles return to the workspace.
    if (elapsed >= 23000) elapsed = 1400;
    render();
    timer = window.setTimeout(tick, 50);
  }

  function schedule() {
    window.clearTimeout(timer);
    render();
    if (playing && !document.hidden) {
      previous = performance.now();
      timer = window.setTimeout(tick, 50);
    }
  }

  button.addEventListener('click', () => {
    playing = !playing;
    schedule();
  });
  document.addEventListener('visibilitychange', schedule);
  motion.addEventListener('change', () => {
    playing = !motion.matches;
    if (motion.matches) elapsed = 10000;
    schedule();
  });
  demo.hidden = false;
  poster.hidden = true;
  schedule();
})();
