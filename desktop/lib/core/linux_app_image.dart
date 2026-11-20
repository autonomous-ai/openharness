import 'dart:convert';
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
  final dataHome = launcherDataHome(env);
  if (appImage == null || appImage.isEmpty || dataHome == null) return;
  try {
    final entry = File('$dataHome/applications/harness.desktop');
    if (await entry.exists()) {
      final existing = await readLauncherEntry(entry);
      final target = launcherExecTarget(existing);
      if (target != null && await File(target).exists()) {
        // Upgrade this executable's own entry, without taking over another copy.
        if (target != appImage) return;
        // The line written now: one an earlier Desktop wrote with a single %
        // is written again.
        if (existing.contains('MimeType=x-scheme-handler/harness;') &&
            existing.contains('Exec=${quoteLauncherExec(appImage)} %u\n')) {
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
      await replaceLauncherFile(icon, await bundleIcon.readAsBytes());
    }
    await entry.parent.create(recursive: true);
    await replaceLauncherFile(
      entry,
      utf8.encode(
        '[Desktop Entry]\n'
        'Type=Application\n'
        'Name=Harness\n'
        'Comment=Attach terminals to the agents running on your Harness machines\n'
        'Exec=${quoteLauncherExec(appImage)} %u\n'
        'MimeType=x-scheme-handler/harness;\n'
        'Icon=${icon.path}\n'
        'Terminal=false\n'
        'Categories=Development;\n'
        'StartupWMClass=$kLinuxAppId\n',
      ),
    );
    if (environment == null) {
      try {
        await Process.run('update-desktop-database', [entry.parent.path]);
      } on ProcessException {
        /* Optional desktop utility. */
      }
    }
    // No path: it holds the person's name.
    appLog.info('app', 'registered launcher entry');
  } on FileSystemException catch (error) {
    appLog.warn('app', 'could not register a launcher entry: ${error.message}');
  }
}

/// Where launcher entries and their icons live: `XDG_DATA_HOME`, else
/// `$HOME/.local/share`; null when neither names a folder. The XDG spec has a
/// relative path ignored, and an entry under one would land wherever Desktop
/// was started. Each without the `/`s that end it: a name goes after one `/`,
/// as the Device app's entry names its icon.
String? launcherDataHome(Map<String, String> environment) {
  final xdg = _folder(environment['XDG_DATA_HOME']);
  if (xdg != null && xdg.startsWith('/')) return xdg;
  final home = _folder(environment['HOME']);
  return home != null && home.startsWith('/') ? '$home/.local/share' : null;
}

/// [path] without the `/`s that end it, so `/` alone is no folder.
String? _folder(String? path) => path?.replaceFirst(RegExp(r'/+$'), '');

/// The program an entry's `Exec=` line starts, as GLib reads it and the Device
/// app too: the string's escapes, then `%%` as `%`, then the quotes, in which a
/// backslash keeps a `"`, a backtick, `$` or `\` and is kept before any other.
/// Null when it has no `Exec=`, or an unclosed quote. A single `%` is kept, so
/// an entry an earlier Desktop wrote without doubling one still names its path.
String? launcherExecTarget(String entry) {
  final exec = launcherEntryValue(entry, 'Exec');
  if (exec == null) return null;
  final value = _unescaped(exec).replaceAll('%%', '%');
  if (value.startsWith('"')) {
    // The closing quote is the first one no backslash escapes.
    final quoted = RegExp(
      r'^"((?:[^"\\]|\\.)*)"',
      dotAll: true,
    ).firstMatch(value);
    if (quoted == null) return null;
    return quoted[1]!.replaceAllMapped(
      RegExp(r'\\(.)', dotAll: true),
      (match) => '"`\$\\'.contains(match[1]!) ? match[1]! : match[0]!,
    );
  }
  final space = value.indexOf(' ');
  return space < 0 ? value : value.substring(0, space);
}

/// [value] with the Desktop Entry spec's string escapes (`\s`, `\n`, `\t`,
/// `\r`, `\\`) read. Any other keeps its backslash, as GLib read it before it
/// refused such a value, so an entry an earlier writer wrote with `\"` still
/// names its path, and is written again.
String _unescaped(String value) => value.replaceAllMapped(
  RegExp(r'\\(.?)', dotAll: true),
  (match) => switch (match[1]) {
    's' => ' ',
    'n' => '\n',
    't' => '\t',
    'r' => '\r',
    r'\' => r'\',
    _ => match[0]!,
  },
);

/// The value of [entry]'s first `<key>=` line, without the spaces, tabs and
/// carriage return around it: the ones GLib drops, which the Device app drops
/// too. Null when it has none.
String? launcherEntryValue(String entry, String key) {
  for (final line in entry.split('\n')) {
    if (line.startsWith('$key=')) {
      return line.substring(key.length + 1).replaceAll(_padding, '');
    }
  }
  return null;
}

final _padding = RegExp(r'^[ \t\r]+|[ \t\r]+$');

/// Writes a launcher entry or its icon beside [file], flushed, and renames it
/// over it, as the Device app writes its own: a dock never reads half of one.
/// The temp file's name is one per file, so the next write takes over one a
/// killed write left.
Future<void> replaceLauncherFile(File file, List<int> bytes) async {
  final temp = File('${file.path}.tmp');
  try {
    await temp.writeAsBytes(bytes, flush: true);
    await temp.rename(file.path);
  } finally {
    if (await temp.exists()) await temp.delete();
  }
}

/// A launcher entry's text, as the Device app reads one: a byte that is not
/// UTF-8 reads as U+FFFD, and the rule still reads its lines.
Future<String> readLauncherEntry(File entry) async =>
    utf8.decode(await entry.readAsBytes(), allowMalformed: true);

/// A path as the Desktop Entry spec wants it in `Exec=`: quoted when it holds
/// a character the launcher would otherwise split or expand on, with `"`, a
/// backtick, `$` and `\` backslashed, and every `%` doubled, as the spec keeps
/// a single one for field codes; then the string's escape over it, every
/// backslash doubled again, as the spec reads a value before its quotes (GLib
/// finds no `Exec=` in `\"`).
String quoteLauncherExec(String path) {
  final doubled = path.replaceAll('%', '%%');
  if (!_quoted.hasMatch(path)) return doubled;
  final escaped = doubled.replaceAllMapped(
    RegExp(r'["`$\\]'),
    (match) => '\\${match[0]}',
  );
  return '"${escaped.replaceAll(r'\', r'\\')}"';
}

/// What `Exec=` quotes, the list the Device app's exec_value holds: Unicode's
/// White_Space, which a launcher may split an argument on (KDE's does), and
/// what the Desktop Entry spec reserves.
final _quoted = RegExp(
  r'''[\x09-\x0d \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000"'\\$`<>~|&;*?#()]''',
);
