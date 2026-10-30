import 'dart:io';

import 'harness_file_store.dart';

/// Held while `harness flash` needs the dial's USB serial port to itself.
///
/// Flashing runs `harness stop` first — a serial port on macOS is exclusive, so the daemon has to let
/// go — and then writes for the better part of a minute. Meanwhile the app supervises that same
/// daemon on a five-second timer and starts it again the moment it notices it is gone. The daemon
/// comes up, reopens the dial, and esptool loses the port mid-write: the flash dies a few tens of
/// kilobytes in with "No more data to read from the serial port", which reads like broken hardware
/// and is not.
abstract final class SerialPortLease {
  /// How long a flag left behind by a flash that could not clean up is believed.
  ///
  /// A write takes a couple of minutes; ten is generous and still bounded. Without a bound, a script
  /// killed with -9 would switch daemon supervision off for the rest of the machine's life — a worse
  /// fault than the one this prevents, and a silent one.
  static const _staleAfter = Duration(minutes: 10);

  /// Where the flasher keeps downloads and its `flashing` flag.
  /// Honours the script's override so both sides look in the same folder.
  static String flasherDirectory({Map<String, String>? environment}) {
    final env = environment ?? Platform.environment;
    return env['HARNESS_FLASHER_CACHE'] ??
        HarnessFileStore.defaultDirectoryPath(
          environment: environment,
          name: 'flasher',
        );
  }

  /// Whether a flash is holding the port.
  ///
  /// Someone running `harness flash` in a terminal while the app is open would otherwise have the
  /// app restart the daemon underneath them, and their flash dies.
  ///
  /// The flasher writes this file before it stops the daemon and removes it when it starts it again.
  static bool heldByAnotherProcess({Map<String, String>? environment}) {
    try {
      final dir = flasherDirectory(environment: environment);
      if (_fresh(File('$dir/flashing'))) return true;
      // A PowerShell flash given a run id has a unique file so a forced stop can retire exactly its
      // own lease. Bash and other PowerShell runs keep the shared timestamp above.
      final directory = Directory(dir);
      if (!directory.existsSync()) return false;
      final runName = RegExp(r'^flashing\.[0-9a-f]{32}$');
      return directory
          .listSync(followLinks: false)
          .whereType<File>()
          .any(
            (file) =>
                runName.hasMatch(file.uri.pathSegments.last) && _fresh(file),
          );
    } catch (_) {
      // Unreadable is not "being flashed": failing open here only risks the collision this guards
      // against, while failing closed would strand the daemon on any filesystem hiccup.
      return false;
    }
  }

  static bool _fresh(File file) {
    try {
      final started = int.tryParse(file.readAsStringSync().trim());
      if (started == null) return false;
      final age = DateTime.now().difference(
        DateTime.fromMillisecondsSinceEpoch(started * 1000),
      );
      return !age.isNegative && age < _staleAfter;
    } on FileSystemException {
      return false;
    }
  }
}
