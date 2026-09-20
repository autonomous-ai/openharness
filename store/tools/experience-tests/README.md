# Experience verification

Art, Music and Creative Direction have authoring rebuilds listed in the Store for user testing;
their source is inside each package's `template/studio/`, with a drawing program/project or an
editable score or brand project. `build-experiences.mjs` delegates to their package builders.
The four parked packages and the retained original models live in `store/tools/experiences/`.
See [the product review](../../../work/SUPERPOWERS.md) and
[current evidence](../../../work/AUTHORING-REBUILD.md). These are technical checks, not product approval.

Creative Direction's [evidence](../../../work/FORME-REBUILD.md) includes three distinct briefs,
targeted revisions, actual canvas/source saves and independently read print deliveries. Run its
`test/acceptance.mjs`, then `test/verify-delivery.py PATH_TO_RUN` with Poppler available.

From the repository root:

```sh
node store/tools/build-experiences.mjs
node store/tools/build-experiences.mjs --check
node store/tools/build-experience-branding.mjs --check
node --test store/tools/experience-tests/models.test.mjs
node --test store/agents/generative-art/test/*.test.mjs store/agents/music-studio/test/*.test.mjs
node --test store/viewers/web-viewer/test/*.test.mjs
```

The parked packages include a pure-model checker. Run it **in their workspace**:

```sh
node tools/check.mjs --seeds 100
```

It extracts the pure model from the actual edited artifact, exercises domain invariants over the
requested seeds, repeats each result and writes `.harness/model-check.json`. It does not claim
browser, visual or listening verification and does not mark the workspace ready.

The rebuilt Art and Music workspaces use `node tools/check.mjs` for source/preview agreement and
`node tools/export.mjs` for real browser delivery. Art supports `--seeds N --scale 1|2|4`; Music
exports the score, mix, MIDI and aligned stems. Their setup scripts install pinned tools locally.
Neither exporter sets a ready verdict from technical measurements.

To reproduce all six targeted revisions, including the saved-project import/backup workflow:

```sh
node store/tools/experience-tests/revisions.mjs /tmp/authoring-revisions --export
python3 -m venv /tmp/music-delivery-reader
/tmp/music-delivery-reader/bin/pip install mido==1.3.3
/tmp/music-delivery-reader/bin/python store/tools/experience-tests/verify-music-delivery.py /tmp/authoring-revisions/keepsake/after
```

The independent reader checks WAVs, MIDI and stem summation with Python wave/zipfile and Mido.
It deliberately reports `listeningReviewed:false`.

## Real browser suite

Install the pinned development dependency in this directory, with system Chrome available:

```sh
npm install
npm run browser
```

`BROWSER_EXECUTABLE` selects another Chromium executable. `PLAYWRIGHT_MODULE` can select an existing
Playwright Core module by absolute path. `EXPERIENCE_OUTPUT` selects the evidence directory (default:
`work/experience-evidence`). Set `EXPERIENCE_IDS=generative-art,music-studio` to select the rebuilt
tools. The test dependency is local to this directory; production export dependencies live in
the two packages' toolchain directories, outside user workspaces.
Set `SOFTWARE_WEBGL=1` to exercise SwiftShader instead of the machine's graphics driver.
Run `node performance.mjs` for 30 warmed artifact requests and five save-to-ready-and-paint
samples per experience. It waits for the changed document and two animation frames, not just
an iframe URL change. Timing is local measurement, not a performance guarantee.

The suite creates temporary workspaces, copies each template, runs its init script, expands the
manifest's actual viewer URL, and starts **this checkout's** viewer. It checks real controls,
downloads and their contents, seed changes and reload preservation, paused file edits, 390px
layouts, browser exceptions and screenshots. A separate fixture verifies sibling fetch,
localStorage, ES modules and recovery when a missing artifact is created.

The retained original-model suite checks 100 art/brand/data/music-score/arena/autopilot seeds, 16 rendered audio
arrangements and 32 walkable voxel worlds. These are finite samples, not a claim about every seed
or every browser. Browser tests are separate from Node coverage; a Node coverage number must
never be reported as coverage of the UI or shell scripts.

## Running app integration

With the local daemon running and these seven agents plus `autonomous/web-viewer` installed from
this checkout, run `HARNESS_MACHINE_ID=<local machine id> node daemon.mjs`. It creates temporary
idle Claude sessions through the desktop's loopback protocol, checks engine readiness, framework
materialization, instructions, initial verdicts, installed viewer routing and a browser file reload.
It sends no prompts and deletes only its own temporary sessions and workspaces in cleanup.
`EXPERIENCE_IDS` also selects packages here. A passing idle-session check does not establish that
the coding engine can complete a real brief. That is a separate acceptance gate.

## Original harness identities

Each package's `brand/icon.svg` is the source for its mark. The experience builder embeds it into
the workspace header and a data-URL favicon so both work offline. The desktop's shared
`EngineIdentity` mapping uses the corresponding `assets/engine-icons/<id>.png` for Store cards,
the picker, pane headers and native tabs. Those bundled icons arrive with a desktop build;
publishing a Store package cannot replace an already-running desktop binary's assets.

After editing a source vector, use the same Chrome/Playwright setup as the browser suite:

```sh
node store/tools/build-experience-branding.mjs
node store/tools/build-experiences.mjs
```

The branding builder renders 256px PNGs, creates light/dark SVG logo lockups and a visual proof
sheet at 16/24/48px. `--check` needs no browser: it verifies source hashes, logo generation, PNG
dimensions and byte-for-byte agreement between package and desktop assets. The original marks
are MIT-licensed work by OpenHarness contributors; they represent these harnesses, not third-party
products. The brand assets are available from each package README.
