# Vendored browser scripts

- `jsQR.js` — [jsQR](https://github.com/cozmo/jsQR) 1.4.0, Apache-2.0 (`jsQR.LICENSE`). Decodes QR codes
  from camera frames for the in-app "Scan its code" (`lib/viewer/qr_scanner_web.dart`) on browsers
  without the native `BarcodeDetector` (iOS Safari). Loaded on demand only, and served from this
  origin rather than a CDN: this page holds the browser's E2EE keys.
