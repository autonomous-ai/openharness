import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';

import 'runtime_platform.dart';

/// Opens an http(s) [url] in the person's browser. True when a browser was
/// asked to; anything else (another scheme, nothing to open it with) is false.
///
/// Under WSL that is the WINDOWS browser, through `explorer.exe` (WSL
/// interop): `url_launcher` would run the distro's `xdg-open`, and a WSL
/// distro rarely has a browser of its own. A viewer on `127.0.0.1` inside WSL
/// is still reachable from Windows through WSL's localhost forwarding, which
/// is on by default. `explorer.exe` exits non-zero even when it opened the
/// page, so starting it is the success signal there.
Future<bool> openInBrowser(Uri url) =>
    (url.scheme == 'http' || url.scheme == 'https') && url.host.isNotEmpty
    ? browserOpener(url)
    : Future.value(false);

@visibleForTesting
Future<bool> Function(Uri url) browserOpener = _open;

Future<bool> _open(Uri url) async {
  if (RuntimePlatform.isWsl) {
    try {
      await Process.start('explorer.exe', [
        url.toString(),
      ], mode: ProcessStartMode.detached);
      return true;
    } catch (_) {
      // No interop (disabled in wsl.conf): fall through to the distro's own.
    }
  }
  return launchUrl(url, mode: LaunchMode.externalApplication);
}
