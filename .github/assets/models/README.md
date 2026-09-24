The Models screenshot uses synthetic model and account data rendered by the real Flutter panel.
It shows pause for a running model, play for downloaded weights, and download for available models.

Regenerate from `desktop/`:

```sh
HARNESS_MODELS_CAPTURE_DIR=/tmp/models-captures flutter test --no-pub test/models_panel_test.dart --plain-name 'Models ready in dark'
cp /tmp/models-captures/dark-ready.png ../.github/assets/models/models-local.png
```

The Models desktop coverage gate is `node tool/check_models_coverage.mjs` after the focused tests run with `--coverage`.
