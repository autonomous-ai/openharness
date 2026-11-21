import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;

import '../core/harness_home.dart';
import '../core/home_dir.dart';

/// The daemon's Windows pipe, as the core records it, and the token that
/// proves it (CLI `lib/daemonRecord.ts`, `lib/windows/pipeAuth.ts`).
///
/// The pipe's name is new on each daemon start, so it is read from the record
/// and never derived as the Unix socket's path is. Read again for every trusted
/// request: a daemon that restarted is found under its new name, and a name it
/// left behind is never dialled once the record has moved on.
class DaemonPipeRecord {
  const DaemonPipeRecord({
    required this.pipePath,
    required this.pipeId,
    required this.token,
  });

  /// `\\.\pipe\harness-<id>`; off Windows, in tests, a Unix socket with that name.
  final String pipePath;

  /// The 32 hex digits that end [pipePath], which every nonce starts with.
  final String pipeId;

  /// The daemon's 32-byte token, read from `daemon-token` beside the record.
  final Uint8List token;
}

/// A local pipe named harness-<32 hex>, nothing else: not a file, not another
/// computer's pipe (`\\host\pipe\…`, an SMB connection that can carry this
/// user's credentials), not a name that only ends that way.
final _localPipe = RegExp(r'^\\\\\.\\pipe\\harness-([0-9a-f]{32})$');

/// What the CLI's tests record off Windows (`isPipePath`): a socket whose last
/// part is harness-<32 hex>.
final _standIn = RegExp(r'(?:^|/)harness-([0-9a-f]{32})$');

/// A whole token file: 64 lower-case hex digits and an optional newline.
final _tokenText = RegExp(r'^[0-9a-f]{64}\n?$');

/// The record is a few dozen bytes; anything much larger is not one.
const _maxRecordBytes = 4096;

/// The daemon's data folder: `ADAPTER_DATA_DIR`, else `cli\data` in Harness's
/// data root (`%USERPROFILE%\.harness` on Windows). An absolute
/// `ADAPTER_DATA_DIR` is kept exactly as written, any other resolved against
/// the home as every Harness process reads it (`homePath` in
/// cli/src/config/envFields.ts), never the app's start folder: the socket
/// folder is a hash of this text. Null when it needs a home and there is none.
/// [look] is for tests: the root is found by it, this computer's by default.
String? defaultDaemonDataDir({
  Map<String, String>? environment,
  bool? isWindows,
  HomeLook? look,
}) {
  final env = environment ?? Platform.environment;
  final windows = isWindows ?? Platform.isWindows;
  final context = windows ? p.windows : p.posix;
  final override = env['ADAPTER_DATA_DIR'];
  final overridden = override != null && override.isNotEmpty;
  if (overridden &&
      context.isAbsolute(override) &&
      !context.isRootRelative(override)) {
    return override;
  }
  final home = maybeHomeDir(environment: env, isWindows: windows);
  if (home == null) return null;
  if (overridden) return _underHome(context, home, override);
  // The Linux rule never runs for a Windows path, whatever the host: no
  // Windows profile has the XDG roots.
  final harness = windows
      ? HarnessHome.at(context.join(home, harnessHomeName), join: context.join)
      : HarnessHome.of(
          home,
          join: context.join,
          look: look ?? platformHomeLook(environment: env),
        );
  return context.join(harness.path(HarnessEntry.cli), 'data');
}

/// A Windows drive-relative path (`C:data`): a drive with no root after it.
final _driveRelative = RegExp(r'^([A-Za-z]):(?![\\/])');

/// [value] resolved against [home], as Node's `path.resolve` does for the CLI:
/// tidied, a root-relative one (`\data`) on the home's drive, and a
/// drive-relative one in the home when it names the home's drive.
String _underHome(p.Context context, String home, String value) {
  final drive = context.style == p.Style.windows
      ? _driveRelative.firstMatch(value)
      : null;
  if (drive == null) return context.normalize(context.join(home, value));
  final rest = value.substring(2);
  final homeDrive = home.length > 1 && home[1] == ':' ? home[0] : null;
  return context.normalize(
    homeDrive?.toLowerCase() == drive[1]!.toLowerCase()
        ? context.join(home, rest)
        : '${drive[1]}:\\$rest',
  );
}

/// The pipe and token of the daemon on [port] in [dataDir], or null when there
/// is nothing to trust: no record, a record that names no pipe or not a Harness
/// pipe, no token, a token of the wrong length or form, a link where a file
/// should be, or a file that cannot be read. [isWindows] (the host by default)
/// decides which pipe names count.
DaemonPipeRecord? readDaemonPipeRecord({
  required String dataDir,
  required int port,
  bool? isWindows,
}) {
  final windows = isWindows ?? Platform.isWindows;
  try {
    final record = _regularFile(p.join(dataDir, 'daemon-$port.json'));
    if (record == null || record.lengthSync() > _maxRecordBytes) return null;
    final value = jsonDecode(record.readAsStringSync());
    final pipe = value is Map ? value['pipe'] : null;
    if (pipe is! String) return null;
    final match = (windows ? _localPipe : _standIn).firstMatch(pipe);
    if (match == null) return null;
    final token = _readToken(p.join(dataDir, 'daemon-token'));
    if (token == null) return null;
    return DaemonPipeRecord(
      pipePath: pipe,
      pipeId: match.group(1)!,
      token: token,
    );
  } on FileSystemException {
    return null;
  } on FormatException {
    return null;
  }
}

/// The loopback port the daemon on [port] actually bound, from its record in
/// [dataDir] (`daemon-<port>.json`'s `port`; CLI `savedDaemonPort`), or null
/// when there is no record or it names no port.
///
/// It differs from [port] when another OS user's daemon held [port] at start
/// (CLI `hookServer.ts`, `allowPortFallback`): [port] then leads to that
/// user's daemon, never to this one.
int? readDaemonTcpPort({required String dataDir, required int port}) {
  try {
    final record = _regularFile(p.join(dataDir, 'daemon-$port.json'));
    if (record == null || record.lengthSync() > _maxRecordBytes) return null;
    final value = jsonDecode(record.readAsStringSync());
    final bound = value is Map ? value['port'] : null;
    return bound is int && bound > 0 && bound <= 65535 ? bound : null;
  } on FileSystemException {
    return null;
  } on FormatException {
    return null;
  }
}

/// [path] when it is a regular file itself, not a link to one, as the CLI's
/// token reader requires (`requireWindowsStateFile`).
File? _regularFile(String path) =>
    FileSystemEntity.typeSync(path, followLinks: false) ==
        FileSystemEntityType.file
    ? File(path)
    : null;

Uint8List? _readToken(String path) {
  final file = _regularFile(path);
  if (file == null) return null;
  final handle = file.openSync();
  final Uint8List bytes;
  try {
    // One byte more than a whole token file, so a longer one is seen as such.
    bytes = handle.readSync(66);
  } finally {
    handle.closeSync();
  }
  final text = latin1.decode(bytes);
  if (!_tokenText.hasMatch(text)) return null;
  return Uint8List.fromList([
    for (var i = 0; i < 64; i += 2)
      int.parse(text.substring(i, i + 2), radix: 16),
  ]);
}
