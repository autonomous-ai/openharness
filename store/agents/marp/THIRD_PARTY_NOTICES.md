# Third-party notices

**Marp** — [marp-team/marp-core](https://github.com/marp-team/marp-core) 4.1.0 and
[marp-team/marp-cli](https://github.com/marp-team/marp-cli) 4.2.3, by Yuki Hattori and the Marp team.
MIT License, copyright (c) 2018 Marp team (marp-team@marp.app) — `LICENSE-marp`. Not vendored: installed
from npm by `toolchain/setup.sh` at the versions pinned in `toolchain/package.json`, and run unmodified.
The `marp-browser.js` the viewer serves is marp-core's own browser bundle, served from that install.
The Marp mark on the Harness tile is the Marp team's, used to name their project.

**Chrome for Testing headless shell** — Google, BSD-3-Clause with the third-party licences listed in the
download's own `LICENSE.headless_shell`. Only on a machine with no Chromium-family browser of its own:
`toolchain/setup.sh` downloads it from Google's Chrome for Testing bucket at the version marp-cli's
puppeteer-core is pinned to, checks it against a pinned SHA-256, and marp-cli renders PDF and PPTX
through it, unmodified. Not vendored.

Everything else here — the keynote themes, the art generator, the viewer page, the check, the
workspace template — is Autonomous's under `LICENSE`.
