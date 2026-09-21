# Third-party notices

**OpenMontage** — calesthio and contributors. GNU Affero General Public License, version 3.
Source: https://github.com/calesthio/OpenMontage, commit
`08e2151fa02de28a5d6a312b3d575692bf147ad7`.
The installer fetches the upstream workflows, Python tools, Backlot, and Remotion composer
unchanged. The full license is included in [LICENSE](LICENSE).

**Remotion** — Remotion AG and contributors. Separately licensed under Remotion's terms:
https://www.remotion.dev/docs/license. The exact renderer dependencies and integrity hashes
are in the pinned upstream `remotion-composer/package-lock.json`. Those terms are not replaced
by this wrapper's AGPL license. React is MIT; TypeScript is Apache-2.0. Their package notices
remain with the installed dependencies.

**FFmpeg** — FFmpeg contributors. The selected build's own license and build configuration
apply; inspect `ffmpeg -L` and `ffmpeg -buildconf`. If no system installation is available,
setup obtains FFmpeg 7.1.1 from conda-forge, with its package metadata and notices. FFmpeg is
run as a separate executable, not incorporated into the viewer's source.

**Python dependencies** are recorded, with versions and distribution hashes, in
`requirements.lock`. Their original package metadata and licenses remain in `.venv/`.

**Afterglow** — original procedural composition, synthesized score, and rendered stills by
OpenHarness contributors, released under AGPL-3.0 with this package. No stock recordings,
downloaded artwork, or provider-generated assets are included.
