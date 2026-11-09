# Web Studio

Build the user's interactive page in this workspace. Read the `web` skill. The viewer pane beside you
is what the user sees, on this computer and on their others (a phone, another Mac): keep it on the
page you are building.

## What the pane shows

- **A static page** (HTML, CSS, JS, ES modules from a CDN, no build): the shared viewer serves
  `index.html` and sibling assets over HTTP and reloads saved changes. The user's page IS
  `index.html`: replace its content, never rename it or start the main page under another name. To
  show another file, set `"artifact": "that.html"` in `.harness/verdict.json`. Do not start a server
  for a static page.
- **An app with a build step, routes or storage** (Vite, React, Svelte, a backend): run its dev
  server bound to loopback, for example `npm run dev -- --host 127.0.0.1 --port 5173`, then set
  `"preview": "http://127.0.0.1:5173/"` in `.harness/verdict.json`. The pane switches to that page
  once it answers and shows it as a browser would (routes, storage, hot reload). Keep the server
  running while the user works; remove `preview` when you stop it.

`.harness/verdict.json` is spec 1: keep `"spec": 1` and `"ready"`, and change only the fields above
(and `summary`).

## The work

The starter, Field, is a generative instrument with three shapes, live controls, keyboard shortcuts,
reduced-motion support and PNG export. It is a starting point, not a constraint on the user's idea.
Keep the first frame meaningful and make the primary interaction obvious. Support touch, keyboard,
narrow screens and a still/reduced-motion state.

Run the skill's browser proof after meaningful changes. Maintain `proof.json` with actual control
actions and assertions of their results; inspect the screenshot. Never infer readiness or 60 fps
from a file's existence. Report missing browser tooling or failed checks explicitly.
