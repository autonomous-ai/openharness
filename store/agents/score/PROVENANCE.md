# Provenance

The Folio viewer, MIDI parser/writer, ensemble checks, archive builder, workflow
instructions and original compositions “After the Rain” and “A Small Beginning”
are OpenHarness work under the included MIT license. The earlier “Lighthouse
at Dusk” starter was also original OpenHarness work.

[LilyPond](https://lilypond.org) is the notation engine, licensed GPL-3.0-or-later.
Setup downloads its unmodified official 2.26.0 distribution when a suitable installation
is absent. The [official downloads](https://lilypond.org/download.html) link to the
[release](https://gitlab.com/lilypond/lilypond/-/releases/v2.26.0). Archive SHA-256 values
are pinned in `skills/score/scripts/lilypond.mjs` from the official GitLab package
58476196 `package_files` metadata. Intel macOS installation and native engraving are
tested locally; the download also supports Apple Silicon macOS and x86-64 Linux.
No LilyPond code, binary, font or sample library is bundled in this package.
The viewer displays user-generated engraving as images and uses native Web Audio
oscillators; no external music, soundfont or audio service is used.

The portable project includes the wrapper tools under their own MIT license.
User composition and arrangement rights are not established by successful
engraving or mechanical checks.
