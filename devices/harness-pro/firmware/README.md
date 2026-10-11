# Harness Pro firmware

## Release runbook (OTA)

Maintainer only; needs ESP-IDF 5.5.4 at `~/esp/esp-idf-5.5.4` and an authenticated `gcloud`.

1. Preview: `make upload-pro ARGS="--dry-run"`. It reads the `harness-pro` key of the shared
   manifest (`harness/esp32/ota/metadata.json`), picks patch+1 (0.1.0 if the key is absent), builds
   into `build-release/` with a throwaway sdkconfig and `-DPOD_PANEL_TURN=180`, checks the image, and prints the gcloud commands.
2. Publish: `make upload-pro`. Uploads `harness/esp32-pro/bin/X.Y.Z.bin` (never overwriting a published .bin), then merges only
   `data["harness-pro"]` = `{version,url,sha256,size}` into the manifest (the round dial's key is untouched). It aborts if the manifest cannot be read, is not an object, or any other key would change, and uploads with a generation precondition (concurrent publish aborts).
3. Vet any image by hand: `scripts/upload-firmware.sh --check-only BIN`.

An image is refused unless it is chip esp32p4, minimum revision v3.0, project `harness_pro`, and a plain
`X.Y.Z` version (dev builds such as `0.0.99-pod` never publish). Test: `bash test/test_upload_checks.sh`.
