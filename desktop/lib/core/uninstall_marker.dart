import 'dart:io';

import 'harness_file_store.dart';

/// `harness uninstall` at work: the CLI's `~/.harness/uninstalling` (cli/src/lib/uninstall/removal.ts
/// `UNINSTALL_MARKER`).
///
/// The uninstall stops the daemon, then removes its files: on macOS and Linux a moment later, on
/// Windows in a cmd.exe that goes on for up to half a minute after the CLI has exited. The
/// supervisor starts a daemon that has gone quiet, and one started in that gap holds `node.exe`
/// and the terminal host's files until a reboot, while the CLI has already said "Harness is
/// uninstalled". The CLI writes the marker before it stops anything, and its last step removes it
/// after every other file, so the daemon stays down until nothing is left to hold.
///
/// Modeled on [SerialPortLease.heldByAnotherProcess]: the file holds the time it was written, in
/// seconds, and is believed for [_staleAfter] only. An uninstall killed half way cannot remove it,
/// and believing it for ever would leave the computer without the daemon the app keeps running.
abstract final class UninstallMarker {
  /// The longest an uninstall runs: a 45 s wait for the daemon lock, the stops, and on Windows the
  /// last step's two-minute wait for the CLI to exit and its retries. Ten minutes is generous and
  /// still bounded.
  static const _staleAfter = Duration(minutes: 10);

  /// The marker's path, or null when no home folder is known.
  static String? path({Map<String, String>? environment}) {
    try {
      return HarnessFileStore.defaultDirectoryPath(
        environment: environment,
        name: 'uninstalling',
      );
    } on StateError {
      return null;
    }
  }

  /// Whether an uninstall wrote the marker and has not finished, as far as its age tells.
  static bool held({Map<String, String>? environment}) {
    final at = path(environment: environment);
    if (at == null) return false;
    try {
      final written = int.tryParse(File(at).readAsStringSync().trim());
      if (written == null) return false;
      final age = DateTime.now().difference(
        DateTime.fromMillisecondsSinceEpoch(written * 1000),
      );
      return !age.isNegative && age < _staleAfter;
    } on FileSystemException {
      // Absent, or unreadable: failing open only risks the race this guards against, while failing
      // closed would strand the daemon on any filesystem hiccup.
      return false;
    }
  }
}
