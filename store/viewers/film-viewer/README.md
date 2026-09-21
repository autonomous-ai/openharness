# Film Viewer

A local screening room for OpenMontage productions. It uses the original **Backlot** state
reader and event stream, with a film player, live storyboard and script, version selection,
timed review notes, and export copies.

Harness installs this shared dependency when a harness names
`"viewer": {"use": "autonomous/film-viewer"}`. It has no agent or generation service of its own.
The [OpenMontage package](../../agents/openmontage/README.md) supplies a complete example.

## Workspace contract

```text
film.json                         {"spec":1,"project":"my-film"}
projects/my-film/
  project.json                    OpenMontage production metadata
  artifacts/                      script, scene plan, assets, edit decisions
  assets/, snapshots/, public/    production media
  renders/                        completed movies; hidden partials are ignored
  checkpoint_*.json, events.jsonl  actual workflow state
  render-progress.json            optional rendering / ready / failed status
  review-notes.json                viewer notes, each tied to a cut and timestamp
exports/                          copies of the selected finished movie
.harness/verdict.json              technical readiness written by the viewer
```

`render-progress.json` can include the renderer PID while running. If it exits without a final
status, the viewer reports interruption and keeps earlier cuts available. Completed videos are
probed before they appear. Each version is identified by path, modification time, and size;
publish immutable files for reliable playback and note history.

The viewer serves `/studio` on the loopback port Harness supplies. Backlot's original board
remains available at `/p/<project>`. No external fonts, analytics, or generation endpoints are
loaded by the screening room.

Only the renderer produces movies. The viewer's write endpoints save review notes and export
copies inside the workspace, require a per-process token, and check the selected revision.
Paths, origins, and local hostnames are checked before files are served. A new cut does not
replace a movie the user is watching until they select it.

## Develop

```sh
bash setup.sh
HARNESS_WORKSPACE=/absolute/workspace HARNESS_VIEWER_PORT=4750 bash viewer.sh
```

Setup installs pinned Python dependencies and Backlot, plus FFmpeg/ffprobe if absent. Launching
from a minimal desktop PATH works after setup. The integration suite is in
[`../../agents/openmontage/test`](../../agents/openmontage/TESTING.md); it drives actual
Chromium and WebKit browsers against disposable productions and performs real video renders.

Verified on macOS Apple Silicon. Remote viewer forwarding and Linux/Windows validation are
outside this package's verified scope.

## Credit and stewardship

[OpenMontage and Backlot](https://github.com/calesthio/OpenMontage) are calesthio's work,
licensed under AGPL-3.0. Setup fetches the unmodified upstream commit in [VERSIONS](VERSIONS).
OpenHarness contributors wrote this screening room and integration, also under AGPL-3.0.
See [LICENSE](LICENSE). This package is an independent integration, not an upstream endorsement;
upstream maintainers are welcome to take over its stewardship.
