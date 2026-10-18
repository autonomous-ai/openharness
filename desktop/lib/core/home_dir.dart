import 'host_platform.dart';
import 'runtime_platform.dart';

/// The current user's home folder: `USERPROFILE` on Windows, `HOME` elsewhere.
///
/// Windows prefers `USERPROFILE` even when `HOME` is set too. Git Bash, MSYS2
/// and Cygwin export a `HOME` of their own (`/c/Users/me`, or a folder on a
/// network share) into every program started from them, while the CLI, its
/// daemon and B's launchers all live in the profile: Node's `os.homedir()` is
/// `USERPROFILE` there, and `pty/src/launcher.rs` (`default_root`) reads it
/// first. An app started from such a shell that read `HOME` would look for
/// `.harness` where the CLI never writes.
///
/// When the platform's own variable is missing or empty the other one is used,
/// on Windows after `HOMEDRIVE` + `HOMEPATH`. On a phone, where none of them
/// exists, it is the app's container ([containerHome]). Null when nothing
/// names a home.
///
/// [environment] and [isWindows] are for tests; they default to this process.
String? maybeHomeDir({Map<String, String>? environment, bool? isWindows}) {
  final env = environment ?? RuntimePlatform.environment;
  String? named(String key) {
    final value = env[key];
    return value == null || value.isEmpty ? null : value;
  }

  if (isWindows ?? RuntimePlatform.isWindows) {
    final drive = named('HOMEDRIVE');
    final path = named('HOMEPATH');
    return named('USERPROFILE') ??
        (drive != null && path != null ? '$drive$path' : null) ??
        named('HOME') ??
        containerHome;
  }
  return named('HOME') ?? named('USERPROFILE') ?? containerHome;
}

/// [maybeHomeDir], for callers that cannot go on without a home folder.
String homeDir({Map<String, String>? environment, bool? isWindows}) {
  final home = maybeHomeDir(environment: environment, isWindows: isWindows);
  if (home == null) {
    throw StateError('Could not resolve the current user home directory');
  }
  return home;
}
