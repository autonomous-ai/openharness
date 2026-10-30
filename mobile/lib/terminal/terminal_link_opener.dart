import 'dart:io';

import 'package:url_launcher/url_launcher.dart';

import 'terminal_links.dart';
import 'remote_media_download.dart';

/// Opens what a program printed: a web link in the OS launcher, and an image or video from the
/// agent's machine in the app's own preview, once its download is complete — never a shell
/// command built from agent text.
class TerminalLinkOpener {
  TerminalLinkOpener({
    Future<bool> Function(Uri)? launch,
    Future<bool> Function(String)? fileExists,
  }) : _launch = launch ?? _launchExternal,
       _fileExists = fileExists ?? _exists;

  final Future<bool> Function(Uri) _launch;
  final Future<bool> Function(String) _fileExists;

  static Future<bool> _launchExternal(Uri uri) =>
      launchUrl(uri, mode: LaunchMode.externalApplication);
  static Future<bool> _exists(String path) => File(path).exists();

  /// Null means the OS accepted the request, or [showLocal] was handed the downloaded copy;
  /// otherwise a user-facing failure.
  ///
  /// [showLocal] shows a downloaded file in the app — the caller's, because only the caller has a
  /// page to show it over. It is never the OS launcher: `url_launcher` opens `file:` URLs on
  /// desktop platforms only. iOS refuses them, and Android has no FileProvider here to hand one to
  /// another app, so a launch of the local copy failed on every phone, every time.
  Future<String?> open(
    String target, {
    Future<String> Function(String target)? downloadRemote,
    void Function(String localPath)? showLocal,
    bool Function()? isCancelled,
  }) async {
    if (RegExp(r'[\x00-\x1f\x7f]').hasMatch(target)) {
      return 'This link is not supported.';
    }
    try {
      final parsed = Uri.tryParse(target);
      if (parsed == null) return 'This link is not supported.';
      Uri uri;
      if (parsed.scheme == 'https' || parsed.scheme == 'http') {
        if (parsed.host.isEmpty) return 'This link is not supported.';
        uri = parsed;
      } else {
        if (parsed.scheme == 'file' &&
            parsed.host.isNotEmpty &&
            parsed.host != 'localhost') {
          return 'This file is on another machine.';
        }
        if (parsed.hasScheme &&
            parsed.scheme != 'file' &&
            !RegExp(r'^[a-z]:[\\/]', caseSensitive: false).hasMatch(target)) {
          return 'This link is not supported.';
        }
        if (!isMediaPath(parsed.scheme == 'file' ? parsed.path : target)) {
          return 'Only image and video files can be opened here.';
        }
        if (downloadRemote == null) {
          return 'This file is on another machine. Update Harness to download a preview.';
        }
        // Asked before the download, not after it: a copy with nowhere to be shown would be up to
        // 512 MB fetched over the relay for nothing.
        if (showLocal == null) return 'Could not open this preview.';
        // Resolve paths on the owning machine; open only the completed local copy.
        final localPath = await downloadRemote(target);
        if (isCancelled?.call() == true) return null;
        if (!await _fileExists(localPath)) {
          return 'The downloaded preview is no longer available. Try again.';
        }
        if (isCancelled?.call() == true) return null;
        showLocal(localPath);
        return null;
      }
      if (isCancelled?.call() == true) return null;
      if (!await _launch(uri)) {
        return 'Could not open this preview. Check that a default app is installed.';
      }
      return null;
    } on RemoteMediaCancelled {
      return null;
    } on RemoteMediaException catch (error) {
      return error.message;
    } catch (_) {
      return 'Could not open this preview. Check that the file is accessible and a default app is installed.';
    }
  }
}
