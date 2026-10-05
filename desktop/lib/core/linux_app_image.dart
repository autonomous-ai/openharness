import 'dart:io';

import '../logging/app_log.dart';
import 'runtime_platform.dart';

/// The window's app id (`APPLICATION_ID` in linux/CMakeLists.txt). A launcher
/// entry names it as `StartupWMClass` so a dock matches the running window to
/// the entry — and draws its icon — instead of a generic gear.
const kLinuxAppId = 'com.autonomous.harness';

/// Puts Harness in the desktop's application list when it runs from an
/// AppImage nothing installed.
///
/// An AppImage is one executable file. Double-clicked from Downloads it runs,
/// but no desktop registers it: "Show Applications" never lists it, and the
/// dock shows its window with a gear. The website installer
/// (`website/scripts/desktop-install.sh`) writes the launcher entry and icon
/// itself; this does the same for an AppImage started any other way, which the
/// AppImage runtime announces by setting `APPIMAGE` to the file's path.
///
/// An entry that already launches an AppImage still on disk is left alone —
/// the installer's, or one this wrote for a copy elsewhere — so a second copy
/// cannot take the entry over. A missing entry, or one whose file has gone
/// (moved or deleted), is (re)written. Never throws: a launcher entry is not
/// worth failing a launch over.
Future<void> registerAppImageLauncher({
  Map<String, String>? environment,
  String? executable,
}) async {
  if (!RuntimePlatform.isLinux && environment == null) return;
  final env = environment ?? RuntimePlatform.environment;
  final appImage = env['APPIMAGE'];
  final home = env['HOME'];
  if (appImage == null || appImage.isEmpty || home == null || home.isEmpty) {
    return;
  }
  try {
    final dataHome = (env['XDG_DATA_HOME']?.isNotEmpty ?? false)
        ? env['XDG_DATA_HOME']!
        : '$home/.local/share';
    final entry = File('$dataHome/applications/harness.desktop');
    if (await entry.exists()) {
      final target = _execTarget(await entry.readAsString());
      if (target != null && await File(target).exists()) {
        // Upgrade this executable's own entry, without taking over another copy.
        if (target != appImage) return;
        final existing = await entry.readAsString();
        if (existing.contains('MimeType=x-scheme-handler/harness;') &&
            existing.contains(' %u\n')) {
          return;
        }
      }
    }
    // The bundle's icon sits beside the executable, inside the mounted image.
    final bundleIcon = File(
      '${File(executable ?? Platform.resolvedExecutable).parent.path}'
      '/harness.png',
    );
    final icon = File('$dataHome/icons/harness.png');
    if (await bundleIcon.exists()) {
      await icon.parent.create(recursive: true);
      await bundleIcon.copy(icon.path);
    }
    await entry.parent.create(recursive: true);
    await entry.writeAsString(
      '[Desktop Entry]\n'
      'Type=Application\n'
      'Name=Harness\n'
      'Comment=Attach terminals to the agents running on your Harness machines\n'
      'Exec=${_quoteExec(appImage)} %u\n'
      'MimeType=x-scheme-handler/harness;\n'
      'Icon=${icon.path}\n'
      'Terminal=false\n'
      'Categories=Development;\n'
      'StartupWMClass=$kLinuxAppId\n',
    );
    if (environment == null) {
      try {
        await Process.run('update-desktop-database', [entry.parent.path]);
      } on ProcessException {
        /* Optional desktop utility. */
      }
    }
    appLog.info('app', 'registered launcher entry for $appImage');
  } on FileSystemException catch (error) {
    appLog.warn('app', 'could not register a launcher entry: ${error.message}');
  }
}

/// The program an entry's `Exec=` line starts, unquoted; null when it has none.
String? _execTarget(String entry) {
  for (final line in entry.split('\n')) {
    if (!line.startsWith('Exec=')) continue;
    final value = line.substring(5).trim();
    if (value.startsWith('"')) {
      final end = value.indexOf('"', 1);
      if (end < 0) return null;
      return value
          .substring(1, end)
          .replaceAllMapped(RegExp(r'\\(.)'), (match) => match[1]!);
    }
    final space = value.indexOf(' ');
    return space < 0 ? value : value.substring(0, space);
  }
  return null;
}

/// A path as the Desktop Entry spec wants it in `Exec=`: quoted when it holds
/// a character the launcher would otherwise split or expand on.
String _quoteExec(String path) {
  if (!RegExp(r'''[\s"'\\$`<>~|&;*?#()]''').hasMatch(path)) return path;
  final escaped = path.replaceAllMapped(
    RegExp(r'["`$\\]'),
    (match) => '\\${match[0]}',
  );
  return '"$escaped"';
}
