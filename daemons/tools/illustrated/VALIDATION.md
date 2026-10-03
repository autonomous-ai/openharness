# Desktop illustrated collection validation

Validated on 2026-09-29 with Flutter 3.47.2 / Dart 3.13.2 and Xcode on macOS.

- All 2,248 PNGs are reopened by the generator to verify dimensions, lossless
  pixels and transparent edges. Manifest records hashes and alpha bounds.
- 258 daemon, lifecycle and render tests pass: all ten hatch reveals animate,
  every stage/mood asset exists, disabled features and hover focus retain their
  behavior, and gallery navigation preserves the complete zoo state.
- 2,464 native AppKit checks pass, including all 1,124 compact frames, bounded
  decoding and caching, path validation, layout, hover, and the painted center
  of all thirty species/growth combinations on both light and dark bars.
- Gallery captures cover all ten on light and dark backgrounds, plus a narrow
  360px panel. A visual check caught and corrected light-theme control contrast;
  gallery checks were rerun after the correction.
- Analysis of all changed Dart sources and tests reports no issues.
- The universal macOS release build passes. The local review app is signed with
  the existing Apple Development identity and verifies with `codesign --deep
  --strict`. Its updater points to unavailable loopback review metadata, so it
  will not silently switch to the public release. `/Applications/Harness.app`
  is not replaced.

Commands run from `desktop/`:

```sh
flutter test --no-pub test/daemons test/daemon_off_test.dart test/daemon_review_render_test.dart
flutter test --no-pub test/daemon_review_render_test.dart --plain-name gallery
bash tool/check_swarm_titlebar.sh /path/to/flutter --window-layout
```

The illustrated art does not alter earning rules, ownership, hatch outcomes,
consent or saved progress. Rolled traits remain metadata; these curated species
portraits do not draw arbitrary individual markings or accessories.
