# Third-party notices

Godogen — Copyright (c) 2026 Alex Ermolov. MIT license; see [LICENSE-godogen](LICENSE-godogen).
Source: https://github.com/htdt/godogen, commit `05cebffc8b10c5817e8a3db495b82e7b6004ab84`.
Setup fetches its workflow, Babylon.js guide, and asset-generation skill. The wrapper's Node
publisher implements the Babylon/Claude portion of Godogen's `publish.sh` and `render_dir.py`;
the original source remains unchanged in the fetched checkout.

Babylon.js — Apache-2.0. Vite and TypeScript — MIT and Apache-2.0, respectively.
Their exact package versions and integrity hashes are recorded in `package-lock.json`; npm
installs their license files with the dependencies. These projects do not endorse this wrapper.

Alpine Drift's terrain, trees, rider, hut, and gates are original procedural geometry written
for OpenHarness. The starter contains no generated or third-party image, model, or audio assets.
