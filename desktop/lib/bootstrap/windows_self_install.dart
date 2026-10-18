import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import '../core/runtime_platform.dart';
import '../update/windows_update_swap.dart';
import 'windows_user_program_files_native.dart'
    if (dart.library.js_interop) 'windows_user_program_files_web.dart'
    as known_folder;

/// The result of checking a packaged Windows app's launch folder.
sealed class SelfInstallOutcome {
  const SelfInstallOutcome();

  static const alreadyInstalled = AlreadyInstalled();
  static const relaunching = Relaunching();
  const factory SelfInstallOutcome.failed(String message) = SelfInstallFailed;
}

final class AlreadyInstalled extends SelfInstallOutcome {
  const AlreadyInstalled();
}

final class Relaunching extends SelfInstallOutcome {
  const Relaunching();
}

final class SelfInstallFailed extends SelfInstallOutcome {
  const SelfInstallFailed(this.message);
  final String message;
}

/// Hands a packaged copy opened from an extracted zip to its own Harness.exe.
/// The launcher waits for this app to exit before installing and opening the
/// installed copy. An installed copy schedules C4.5's conservative cleanup.
class WindowsSelfInstall {
  WindowsSelfInstall({
    bool? isWindows,
    bool? releaseMode,
    String? executablePath,
    String? installRoot,
    Map<String, String>? environment,
    int? pid,
    Future<void> Function(String executable, List<String> arguments)? start,
    Future<void> Function(String installRoot)? cleanUp,
  }) : _isWindows = isWindows ?? RuntimePlatform.isWindows,
       _releaseMode = releaseMode ?? kReleaseMode,
       // Keep the public fixture parameter names from the C4.6 contract.
       // ignore: prefer_initializing_formals
       _executablePath = executablePath,
       // ignore: prefer_initializing_formals
       _installRoot = installRoot,
       // ignore: prefer_initializing_formals
       _environment = environment,
       // ignore: prefer_initializing_formals
       _pid = pid,
       _start = start ?? _startDetached,
       _cleanUp = cleanUp ?? _cleanUpInBackground;

  final bool _isWindows;
  final bool _releaseMode;
  final String? _executablePath;
  final String? _installRoot;
  final Map<String, String>? _environment;
  final int? _pid;
  final Future<void> Function(String, List<String>) _start;
  final Future<void> Function(String) _cleanUp;

  @visibleForTesting
  Future<void>? lastCleanUp;

  static Future<void> _startDetached(String executable, List<String> args) =>
      Process.start(
        executable,
        args,
        mode: ProcessStartMode.detached,
      ).then((_) {});

  // Constructing the swap takes a shallow snapshot synchronously. This call
  // happens before update polling can stage a new owned attempt.
  static Future<void> _cleanUpInBackground(String root) =>
      WindowsUpdateSwap(installRoot: root).cleanUp();

  /// Uses the launcher's override or FOLDERID_UserProgramFiles + Harness.
  String? installRoot() {
    if (_installRoot != null) {
      return _installRoot;
    }
    final override =
        (_environment ??
        RuntimePlatform.environment)['HARNESS_DESKTOP_INSTALL_ROOT'];
    if (override != null && override.isNotEmpty) {
      return override;
    }
    final programs = userProgramFilesFolder();
    return programs == null ? null : p.join(programs, 'Harness');
  }

  Future<SelfInstallOutcome> ensureInstalled() async {
    if (!_isWindows || !_releaseMode) {
      return SelfInstallOutcome.alreadyInstalled;
    }
    try {
      final exe = _executablePath ?? RuntimePlatform.resolvedExecutable;
      final here = layoutRootOf(exe);
      if (here == null) {
        return SelfInstallOutcome.alreadyInstalled;
      }
      // The geometry identifies a packaged copy. Its pointer must also be
      // readable before asking the launcher to install it.
      if (readPointer(p.join(here, 'current')) == null) {
        return const SelfInstallOutcome.failed(
          'This copy of Harness has no readable current version, so it cannot install itself. Download Harness again.',
        );
      }
      final install = installRoot();
      if (install == null) {
        return const SelfInstallOutcome.failed(
          'Harness could not find where Windows keeps your programs, so it is running from this folder.',
        );
      }
      final launcher = p.join(here, WindowsUpdateSwap.launcherExe);
      if (!File(launcher).existsSync()) {
        return SelfInstallOutcome.failed(
          'This copy of Harness has no ${WindowsUpdateSwap.launcherExe} beside its app folder, so it cannot install itself. Download Harness again.',
        );
      }
      if (sameFolder(here, install)) {
        try {
          lastCleanUp = _cleanUp(install).catchError((Object error) {
            debugPrint('WindowsSelfInstall: cleanup failed: $error');
          });
        } catch (error) {
          debugPrint('WindowsSelfInstall: cleanup failed: $error');
        }
        return SelfInstallOutcome.alreadyInstalled;
      }
      try {
        await _start(launcher, ['--install', '--wait-pid', '${_pid ?? pid}']);
        // A detached spawn proves only that the launcher started. Its later
        // install failures are explained by its own message box and log.
        return SelfInstallOutcome.relaunching;
      } catch (error) {
        return SelfInstallOutcome.failed(
          'Harness could not start its installer ($error), so it is running from this folder.',
        );
      }
    } catch (error) {
      return SelfInstallOutcome.failed(
        'Harness could not check this copy for installation ($error), so it is running from this folder.',
      );
    }
  }
}

/// Root of an executable shaped like root/app/version/harness-desktop.exe.
/// A non-layout development build returns null; pointer validity is checked by
/// [WindowsSelfInstall.ensureInstalled] so a broken package reports a failure.
String? layoutRootOf(String executable) {
  if (p.basename(executable).toLowerCase() != WindowsUpdateSwap.appExe) {
    return null;
  }
  final app = p.dirname(p.dirname(executable));
  if (p.basename(app).toLowerCase() != 'app') {
    return null;
  }
  return p.dirname(app);
}

/// Compares existing paths by native identity, then Windows-style spelling.
bool sameFolder(String a, String b) {
  String plain(String path) {
    var resolved = path;
    try {
      resolved = Directory(path).resolveSymbolicLinksSync();
    } on FileSystemException {
      // A test override or not-yet-created install is compared as written.
    }
    const extendedPrefix = '\\\\?\\';
    if (resolved.startsWith(extendedPrefix)) {
      resolved = resolved.substring(extendedPrefix.length);
      if (resolved.toLowerCase().startsWith('unc\\')) {
        resolved = '\\\\${resolved.substring(4)}';
      }
    }
    final windows =
        RegExp(r'^[a-zA-Z]:[\\/]').hasMatch(resolved) ||
        resolved.startsWith('\\\\');
    final normalized = windows
        ? p.windows.normalize(resolved)
        : p.normalize(resolved);
    return normalized.replaceAll(RegExp(r'[\\/]+$'), '').toLowerCase();
  }

  return plain(a) == plain(b);
}

/// FOLDERID_UserProgramFiles, or null off Windows or if the shell cannot
/// resolve it. The lookup does not create a directory.
String? userProgramFilesFolder() =>
    RuntimePlatform.isWindows ? known_folder.userProgramFilesFolder() : null;
